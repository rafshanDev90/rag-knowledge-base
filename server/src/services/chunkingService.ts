import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { getEncoding } from 'js-tiktoken'; // FIXED: Using pure JS version
import { DocumentChunk, IDocumentChunk, buildChunkId, hashText } from '../models/DocumentChunk.js';
import { generateEmbeddings } from './embeddingService.js';

export interface SourcePage {
  num: number;
  text: string;
}

export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  tenantId: string;
  blockType?: 'prose' | 'equation' | 'table' | 'code';
  page?: number;
  section?: string;
  /**
   * Optional page-by-page text from the PDF parser. When provided, each chunk
   * gets the page number where it starts, so citations can say "Page 12".
   */
  pages?: SourcePage[];
}

export interface IngestionResult {
  sourceHash: string;
  totalChunks: number;
  insertedCount: number;
  duplicateCount: number;
  skipped: boolean;
  writeErrors: unknown[];
}

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;
const EMBED_BATCH_SIZE = Math.min(
  512,
  Math.max(1, Number(process.env.EMBED_BATCH_SIZE) || 32)
);

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

interface PageRange {
  num: number;
  start: number;
  end: number;
}

/**
 * Build one normalized string for the whole document plus character ranges
 * that map back to source pages. Joining page text with a single space keeps
 * the offsets consistent even though normalization collapses whitespace.
 */
function buildNormalizedSource(
  rawText: string,
  pages?: SourcePage[]
): { normalized: string; ranges: PageRange[] } {
  if (!pages?.length) {
    return { normalized: normalizeText(rawText), ranges: [] };
  }

  const normalizedPages = pages
    .map((page) => ({ num: page.num, text: normalizeText(page.text) }))
    .filter((page) => page.text.length > 0);

  if (normalizedPages.length === 0) {
    return { normalized: normalizeText(rawText), ranges: [] };
  }

  let cursor = 0;
  const parts: string[] = [];
  const ranges: PageRange[] = [];

  for (const page of normalizedPages) {
    const start = cursor;
    parts.push(page.text);
    cursor += page.text.length;
    ranges.push({ num: page.num, start, end: cursor });
    cursor += 1; // the single space used by join(' ')
  }

  return { normalized: parts.join(' '), ranges };
}

/**
 * Find the page where a chunk starts. Falls back to a short prefix probe
 * because the splitter may trim separator characters at chunk boundaries.
 */
function locatePage(
  chunkText: string,
  normalized: string,
  ranges: PageRange[],
  from: number
): { page?: number; from: number } {
  if (ranges.length === 0) return { from };

  let index = normalized.indexOf(chunkText, from);
  if (index === -1 && chunkText.length > 40) {
    index = normalized.indexOf(chunkText.slice(0, 40), from);
  }
  if (index === -1) return { from };

  // The chunk starts inside the page whose range contains it. If it starts on
  // the join space between pages, attribute it to the previous page.
  const range =
    ranges.find((candidate) => index >= candidate.start && index <= candidate.end) ??
    [...ranges].reverse().find((candidate) => index >= candidate.start);

  return { page: range?.num, from: index + 1 };
}

async function embedInBatches(texts: string[]): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    console.log(
      `🧠 Embedding chunks ${start + 1}-${start + batch.length} of ${texts.length}...`
    );
    const batchEmbeddings = await generateEmbeddings(batch);
    embeddings.push(...batchEmbeddings);
  }

  if (embeddings.length !== texts.length) {
    throw new Error(
      `Embedding count mismatch: expected ${texts.length}, got ${embeddings.length}`
    );
  }

  return embeddings;
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
    pages,
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

  const { normalized, ranges } = buildNormalizedSource(rawText, pages);
  const sourceHash = hashText(normalized);

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

  // --- Idempotency check (after splitting so we know the expected count) ---
  const existingCount = await DocumentChunk.countDocuments({ sourceHash, tenantId });
  if (existingCount === totalChunks) {
    return {
      sourceHash,
      totalChunks,
      insertedCount: 0,
      duplicateCount: existingCount,
      skipped: true,
      writeErrors: [],
    };
  }

  // --- Embeddings (batched, retried inside the embedding service) ---
  const embeddings = await embedInBatches(textChunks);

  // --- Build chunk documents ---
  let searchFrom = 0;
  const chunkDocs: Partial<IDocumentChunk>[] = documents.map((doc, index) => {
    const chunkText = doc.pageContent;
    const located = locatePage(chunkText, normalized, ranges, searchFrom);
    searchFrom = located.from;

    return {
      chunkId: buildChunkId(sourceHash, index),
      sourceFile: fileName,
      sourceHash,
      contentHash: hashText(chunkText),
      chunkIndex: index,
      totalChunks,
      text: chunkText,
      tokenCount: countTokens(chunkText),
      blockType,
      page: located.page ?? page,
      section,
      tenantId,
      ingestedAt: new Date(),
      embedding: embeddings[index],
    };
  });

  // A previous ingestion may have inserted only some chunks. Remove the old
  // rows after embeddings succeed, then write the complete set.
  if (existingCount > 0) {
    console.log(
      `♻️  Replacing ${existingCount} stale chunk(s) for ${fileName} (expected ${totalChunks}).`
    );
    await DocumentChunk.deleteMany({ sourceHash, tenantId });
  }

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
      skipped: false,
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
        skipped: false,
        writeErrors: error.writeErrors || [],
      };
    }
    throw error;
  }
}
