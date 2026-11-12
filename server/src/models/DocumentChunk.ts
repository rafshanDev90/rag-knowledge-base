import mongoose, { Schema, Document, Model } from 'mongoose';
import crypto from 'crypto';

export type BlockType = 'prose' | 'equation' | 'table' | 'code';

export interface IDocumentChunk extends Document {
  chunkId: string;              // deterministic: sourceHash + "_" + chunkIndex
  sourceFile: string;
  sourceHash: string;           // SHA-256 of normalized source document
  contentHash: string;          // SHA-256 of this chunk's normalized text
  chunkIndex: number;
  totalChunks: number;          // useful for reconstruction and validation
  text: string;
  tokenCount: number;           // computed at insert time
  blockType: BlockType;
  page?: number;
  section?: string;
  tenantId: string;
  ingestedAt: Date;
  // embedding: number[];       // added in Step 4
  metadata?: Record<string, unknown>;
  embedding?: number[];          // added in Step 4

}

const DocumentChunkSchema = new Schema<IDocumentChunk>(
  {
    chunkId: {
      type: String,
      required: true,
      unique: true,             // enforces deduplication at the index level
      index: true,
    },
    sourceFile: { type: String, required: true,  },
    sourceHash: { type: String, required: true,  },
    contentHash: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    totalChunks: { type: Number, required: true },
    text: { type: String, required: true },
    tokenCount: { type: Number, required: true },
    blockType: {
      type: String,
      enum: ['prose', 'equation', 'table', 'code'],
      default: 'prose',
      required: true,
    },
    page: { type: Number },
    section: { type: String },
    tenantId: { type: String, required: true, index: true },
    ingestedAt: { type: Date, default: () => new Date(), required: true },
    metadata: { type: Schema.Types.Mixed },
    embedding: { type: [Number], required: false, select: false },  // added in Step 4
  },
  {
    timestamps: false,          // ingestedAt is explicit; avoid duplicate timestamp fields
    collection: 'document_chunks',
  }
);

// Compound index: reconstruct a document's chunks in order quickly.
DocumentChunkSchema.index({ sourceFile: 1, chunkIndex: 1 }, { name: 'source_order' });

// Compound index: tenant-scoped ingestion and cleanup.
DocumentChunkSchema.index({ tenantId: 1, sourceHash: 1 }, { name: 'tenant_source' });

// Content-hash lookup for idempotent re-ingestion checks.
DocumentChunkSchema.index({ contentHash: 1 }, { name: 'content_lookup' });

export const DocumentChunk: Model<IDocumentChunk> =
  mongoose.models.DocumentChunk ||
  mongoose.model<IDocumentChunk>('DocumentChunk', DocumentChunkSchema);

export function buildChunkId(sourceHash: string, chunkIndex: number): string {
  return `${sourceHash}_${chunkIndex}`;
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
