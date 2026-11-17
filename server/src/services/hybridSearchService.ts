import { DocumentChunk } from '../models/DocumentChunk.js';
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
} from '@huggingface/transformers';

const RERANKER_MODEL = 'Xenova/bge-reranker-base';

interface RerankerBundle {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

// Singleton promise to cache tokenizer + model cleanly
let rerankerPromise: Promise<RerankerBundle> | null = null;

const getReranker = async (): Promise<RerankerBundle> => {
  if (!rerankerPromise) {
    console.log(`📥 Loading local ONNX reranker (${RERANKER_MODEL})...`);
    rerankerPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL),
    ]).then(([tokenizer, model]) => {
      console.log('✅ Reranker loaded.');
      return { tokenizer, model };
    });
  }
  return rerankerPromise;
};

interface HybridSearchOptions {
  query: string;
  queryEmbedding: number[];
  tenantId: string;
  limit?: number;
  candidates?: number;
  rrf_k?: number;
  vectorWeight?: number;
  keywordWeight?: number;
}

export interface SearchChunk {
  _id: unknown;
  text: string;
  sourceFile: string;
  chunkIndex: number;
  page?: number;
}

export const hybridSearchWithReranking = async (
  options: HybridSearchOptions
): Promise<SearchChunk[]> => {
  const {
    query,
    queryEmbedding,
    tenantId,
    limit = 3,
    candidates = 10,
    rrf_k = 60,
    vectorWeight = 0.6,
    keywordWeight = 0.4,
  } = options;

  // --- PATH 1: Vector Search ---
  const vectorPipeline = [
    {
      $vectorSearch: {
        index: 'vector_index',
        path: 'embedding',
        queryVector: queryEmbedding,
        numCandidates: 100,
        limit: candidates,
        filter: { tenantId },
      },
    },
    { $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1, page: 1 } },
  ];

  // --- PATH 2: Atlas Search (BM25 Keyword) ---
  const keywordPipeline = [
    {
      $search: {
        index: 'text_index',
        text: { query, path: 'text' },
      },
    },
    { $limit: candidates },
    { $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1, page: 1 } },
  ];

  // Execute both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    DocumentChunk.aggregate<SearchChunk>(vectorPipeline),
    DocumentChunk.aggregate<SearchChunk>(keywordPipeline),
  ]);

  // --- MERGE WITH RRF ---
  const rrfScores = new Map<string, { doc: SearchChunk; score: number }>();

  const addToRrf = (results: SearchChunk[], weight: number) => {
    results.forEach((doc, index) => {
      const rank = index + 1;
      const rrfScore = weight * (1 / (rrf_k + rank));
      const docId = String(doc._id);
      const existing = rrfScores.get(docId);

      if (existing) {
        existing.score += rrfScore;
      } else {
        rrfScores.set(docId, { doc, score: rrfScore });
      }
    });
  };

  addToRrf(vectorResults, vectorWeight);
  addToRrf(keywordResults, keywordWeight);

  const fusedResults: SearchChunk[] = Array.from(rrfScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, candidates)
    .map((item) => item.doc);

  if (fusedResults.length === 0) return [];

  // --- RERANKING (Local ONNX Cross-Encoder) ---
  try {
    console.log(`🔄 Reranking ${fusedResults.length} candidates with local ONNX...`);
    const { tokenizer, model } = await getReranker();

    // Pair the query with each candidate document text
    const queries = fusedResults.map(() => query);
    const texts = fusedResults.map((chunk) => chunk.text);

    const inputs = tokenizer(queries, {
      text_pair: texts,
      padding: true,
      truncation: true,
    });

    const { logits } = await model(inputs);
    const scores = Array.from(logits.data as Float32Array);

    // Pair each chunk with its sigmoid-normalized relevance score (0 to 1)
    const scoredResults = fusedResults
      .map((doc, idx) => ({
        doc,
        score: 1 / (1 + Math.exp(-scores[idx])),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.doc);

    console.log('✅ ONNX Reranking complete.');
    return scoredResults;
  } catch (error) {
    console.warn('⚠️ ONNX reranking failed, falling back to RRF order:', error);
    return fusedResults.slice(0, limit);
  }
};
