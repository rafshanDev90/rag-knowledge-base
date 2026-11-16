import { DocumentChunk, IDocumentChunk } from '../models/DocumentChunk.js';
import { Ollama } from 'ollama';

const ollama = new Ollama({ host: 'http://127.0.0.1:11434' });

interface HybridSearchOptions {
  query: string;
  queryEmbedding: number[];
  tenantId: string;
  limit?: number;        // Final number of chunks to return after reranking
  candidates?: number;   // Number of candidates to fetch from each search path
  rrf_k?: number;
  vectorWeight?: number;
  keywordWeight?: number;
}
interface RerankItem {
  doc: any;
  score: number;
}

export const hybridSearchWithReranking = async (options: HybridSearchOptions) => {
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
    { $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1 } },
  ];

  // --- PATH 2: Atlas Search (BM25 Keyword) ---
  const keywordPipeline = [
    {
      $search: {
        index: 'text_index',
        text: { query, path: 'text' },
        // Optional: Add a filter for tenantId if your Atlas Search index supports it
      },
    },
    { $limit: candidates },
    { $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1 } },
  ];

  // Execute both searches in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    DocumentChunk.aggregate(vectorPipeline),
    DocumentChunk.aggregate(keywordPipeline),
  ]);

  // --- MERGE WITH RRF ---
  const rrfScores = new Map<string, { doc: any; score: number }>();

  // Helper to add RRF scores
  const addToRrf = (results: any[], weight: number) => {
    results.forEach((doc, index) => {
      const rank = index + 1;
      const rrfScore = weight * (1 / (rrf_k + rank));
      const existing = rrfScores.get(doc._id.toString());
      
      if (existing) {
        existing.score += rrfScore;
      } else {
        rrfScores.set(doc._id.toString(), { doc, score: rrfScore });
      }
    });
  };

  addToRrf(vectorResults, vectorWeight);
  addToRrf(keywordResults, keywordWeight);

  // Sort by fused RRF score and take the top candidates
  const fusedResults = Array.from(rrfScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, candidates)
    .map((item) => item.doc);

  if (fusedResults.length === 0) return [];

  // --- RERANKING (Cross-Encoder via Ollama) ---
 try {
  console.log(`🔄 Reranking ${fusedResults.length} candidates...`);

  const scoredResults: RerankItem[] = await Promise.all(
    fusedResults.map(async (doc) => {
      const prompt = `Rate how relevant the following passage is to answering the query on a scale of 0 to 10. Respond ONLY with JSON: {"score": number}.

Query: ${query}
Passage: ${doc.text}`;

      const response = await ollama.chat({
        model: 'qllama/bge-reranker-v2-m3:latest', // Use whatever fast chat model you already pulled
        messages: [{ role: 'user', content: prompt }],
        format: 'json',
        options: { temperature: 0 },
      });

      const parsed = JSON.parse(response.message.content) as { score?: number };
      return {
        doc,
        score: typeof parsed.score === 'number' ? parsed.score : 0,
      };
    })
  );

  return scoredResults
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.doc);
} catch (error) {
  console.warn('⚠️ Reranking failed, falling back to RRF order:', error);
  return fusedResults.slice(0, limit);
}
};