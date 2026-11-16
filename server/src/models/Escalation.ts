import mongoose, { Schema, Document } from 'mongoose';

export interface IEscalation extends Document {
  sessionId: string;
  tenantId: string;
  reason: string;
  userQuery: string;
  status: 'pending' | 'resolved';
  createdAt: Date;
}

const EscalationSchema = new Schema<IEscalation>({
  sessionId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true },
  reason: { type: String, required: true },
  userQuery: { type: String, required: true },
  status: { type: String, enum: ['pending', 'resolved'], default: 'pending' },
}, { timestamps: true });

export const Escalation = mongoose.model<IEscalation>('Escalation', EscalationSchema);