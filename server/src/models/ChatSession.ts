// src/models/ChatSession.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IChatSession extends Document {
  sessionId: string;        // UUID exposed to the client
  tenantId: string;         // For multi-tenancy
  userId: string;           // Owner of the session
  title?: string;           // Optional, e.g., "Customer Support - Order #123"
  runningSummary: string;   // The compressed history
  summaryTokenCount: number;
  createdAt: Date;
  updatedAt: Date;
}
/**
 * • sessionId: Stores an external UUID exposed to your frontend client.
 *  Using a separate UUID prevents leaking internal MongoDB ObjectIDs and makes horizontal sharding easier.
 * 
• tenantId: Enforces multi-tenant data isolation in B2B or SaaS architectures. 
  Every database query and vector store filter should include this ID so one organization never accesses another's data.
 */

const ChatSessionSchema = new Schema<IChatSession>({
  sessionId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  title: { type: String },
  runningSummary: { type: String, default: '' },
  summaryTokenCount: { type: Number, default: 0 },
}, { timestamps: true });

export const ChatSession = mongoose.model<IChatSession>('ChatSession', ChatSessionSchema);