// src/models/ChatMessage.ts
import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage extends Document {
  sessionId: string;       // Foreign key to ChatSession
  role: 'user' | 'assistant' | 'system';
  content: string;
  sources?: any[];         // For citations (e.g., [{ file: '...', chunk: 5 }])
  createdAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>({
  sessionId: { type: String, required: true, index: true },
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  sources: { type: [Schema.Types.Mixed] }, 
}, { timestamps: { createdAt: true, updatedAt: false } });

// Compound index for fast history retrieval
ChatMessageSchema.index({ sessionId: 1, createdAt: 1 });

export const ChatMessage = mongoose.model<IChatMessage>('ChatMessage', ChatMessageSchema);