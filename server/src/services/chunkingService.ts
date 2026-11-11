import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { encoding_for_model, TiktokenModel } from 'tiktoken';
import { DocumentChunk, IDocumentChunk, buildChunkId, hashText } from '../models/DocumentChunk.js';

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  tokenModel?: TiktokenModel;
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
const DEFAULT_TOKEN_MODEL: TiktokenModel = 'gpt-4';

function countTokens(text: string, model: TiktokenModel): number {
  const enc = encoding_for_model(model);
  try {
    return enc.encode(text).length;
  } finally {
    enc.free();
  }
}

/**
 * Normalize text before hashing and splitting.
 * Collapsing whitespace prevents trivial formatting differences from
 * producing different hashes for semantically identical content.
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
    tokenModel = DEFAULT_TOKEN_MODEL,
    tenantId,
    blockType = 'prose',
    page,
    section,
  } = options;

  // --- Error boundary: input validation before any database work ---
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

  // --- Idempotency check: skip re-chunking if this source already exists ---
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
    // Prefer structural boundaries when present; fall back to sentence/word boundaries.
    separators: ['\n\n', '\n', '. ', ' ', ''],
  });

  const documents = await splitter.createDocuments([normalized]);
  if (documents.length === 0) {
    throw new Error('Chunking produced zero segments; document may be too short or malformed.');
  }

  const totalChunks = documents.length;

  // --- Build chunk documents with computed token counts and hashes ---
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
      tokenCount: countTokens(chunkText, tokenModel),
      blockType,
      page,
      section,
      tenantId,
      ingestedAt: new Date(),
    };
  });

  // --- Batch persistence with non-ordered writes ---
  // ordered:false means duplicate-key or validation failures on one chunk
  // do not abort the rest of the batch.
  const result = await DocumentChunk.insertMany(chunkDocs, {
    ordered: false,
    lean: true,
  });

  // Mongo insertMany with ordered:false may throw a BulkWriteError
  // containing successful insertions and per-document errors.
  // We catch and normalize that into a result object.
  return {
    sourceHash,
    totalChunks,
    insertedCount: Array.isArray(result) ? result.length : totalChunks,
    duplicateCount: 0,
    writeErrors: [],
  };
}

/**
 * Wrapper that normalizes BulkWriteError so callers get a consistent result.
 * Use this in the controller instead of calling processAndSaveChunks directly
 * if you want partial-success visibility.
 */
export async function processAndSaveChunksSafe(
  rawText: string,
  fileName: string,
  options: ChunkingOptions
): Promise<IngestionResult> {
  try {
    return await processAndSaveChunks(rawText, fileName, options);
  } catch (error: unknown) {
    const bulkError = error as {
      insertedDocs?: unknown[];
      result?: { insertedCount?: number };
      writeErrors?: unknown[];
      code?: number;
    };

    if (bulkError.code === 11000 || bulkError.writeErrors) {
      return {
        sourceHash: hashText(normalizeText(rawText)),
        totalChunks: 0,
        insertedCount: bulkError.result?.insertedCount ?? 0,
        duplicateCount: bulkError.writeErrors?.length ?? 0,
        writeErrors: bulkError.writeErrors ?? [],
      };
    }
    throw error;
  }
}