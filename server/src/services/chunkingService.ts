import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding } from 'js-tiktoken'; // FIXED: Using pure JS version
import { DocumentChunk, IDocumentChunk, buildChunkId, hashText } from '../models/DocumentChunk.js';
import { generateEmbeddings } from './embeddingService.js'; // Ensure this is imported

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  tenantId: string;
  blockType?: 'prose' | 'equation' | 'table' | 'code';
  page?: number;
  section?: string;
}

export interface IngestionResult {
  sourceHash: string;
  totalChunks: number;
  insertedCount: number;
  duplicateCount: number;
  writeErrors: unknown[];
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;

// Initialize the tokenizer once globally
const enc = getEncoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

/**
 * Normalize text before hashing and splitting.
 */
function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export async function processAndSaveChunks(
  rawText: string,
  fileName: string,
  options: ChunkingOptions
): Promise<IngestionResult> {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    chunkOverlap = DEFAULT_OVERLAP,
    tenantId,
    blockType = 'prose',
    page,
    section,
  } = options;

  // --- Error boundary ---
  if (!rawText || rawText.trim().length === 0) {
    throw new Error('Cannot chunk empty document text.');
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error('chunkOverlap must be strictly less than chunkSize.');
  }
  if (!tenantId) {
    throw new Error('tenantId is required for chunk ingestion.');
  }

  const normalized = normalizeText(rawText);
  const sourceHash = hashText(normalized);

  // --- Idempotency check ---
  const existing = await DocumentChunk.exists({ sourceHash, tenantId });
  if (existing) {
    const count = await DocumentChunk.countDocuments({ sourceHash, tenantId });
    return {
      sourceHash,
      totalChunks: count,
      insertedCount: 0,
      duplicateCount: count,
      writeErrors: [],
    };
  }

  // --- Splitting ---
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: ['\n\n', '\n', '. ', ' ', ''],
  });

  const documents = await splitter.createDocuments([normalized]);
  if (documents.length === 0) {
    throw new Error('Chunking produced zero segments; document may be too short or malformed.');
  }

  const totalChunks = documents.length;
  const textChunks = documents.map((doc) => doc.pageContent);

  // --- NEW: Generate Vectors via Ollama ---
  console.log(`🧠 Generating embeddings for ${totalChunks} chunks via Ollama...`);
  const embeddings = await generateEmbeddings(textChunks);

  // --- Build chunk documents ---
  const chunkDocs: Partial<IDocumentChunk>[] = documents.map((doc, index) => {
    const chunkText = doc.pageContent;
    const contentHash = hashText(chunkText);
    return {
      chunkId: buildChunkId(sourceHash, index),
      sourceFile: fileName,
      sourceHash,
      contentHash,
      chunkIndex: index,
      totalChunks,
      text: chunkText,
      tokenCount: countTokens(chunkText),
      blockType,
      page,
      section,
      tenantId,
      ingestedAt: new Date(),
      embedding: embeddings[index], // NEW: Attach the 768-dimensional vector!
    };
  });

  // --- Batch persistence ---
  try {
    const result = await DocumentChunk.insertMany(chunkDocs, {
      ordered: false,
    });
    return {
      sourceHash,
      totalChunks,
      insertedCount: result.length,
      duplicateCount: 0,
      writeErrors: [],
    };
  } catch (error: any) {
    // Handle BulkWriteError (duplicate keys)
    if (error.code === 11000 || error.writeErrors) {
      return {
        sourceHash,
        totalChunks,
        insertedCount: error.result?.insertedCount || 0,
        duplicateCount: error.writeErrors?.length || 0,
        writeErrors: error.writeErrors || [],
      };
    }
    throw error;
  }
}