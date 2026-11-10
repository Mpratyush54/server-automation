import mongoose, { Schema, Document } from 'mongoose';

export interface IErrorDoc extends Document {
  projectId: string;
  environment: string;
  errorType: string;
  message: string;
  stackHash: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrenceCount: number;
  /** Optional subject for GDPR delete (#47); populated by error tracking (#41) when known. */
  userId?: string;
  sessionId?: string;
  fields?: Record<string, any>;
}

const ErrorDocSchema = new Schema<IErrorDoc>({
  projectId: { type: String, required: true, index: true },
  environment: String,
  errorType: { type: String, required: true },
  message: String,
  stackHash: String,
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  occurrenceCount: { type: Number, default: 1 },
  userId: { type: String, index: true },
  sessionId: { type: String, index: true },
  fields: { type: Schema.Types.Mixed },
}, { collection: 'errors' });

ErrorDocSchema.index({ projectId: 1, errorType: 1 });
ErrorDocSchema.index({ lastSeen: -1 });
ErrorDocSchema.index({ projectId: 1, userId: 1 });
ErrorDocSchema.index({ projectId: 1, sessionId: 1 });
export const ErrorDocModel = mongoose.model<IErrorDoc>('ErrorDoc', ErrorDocSchema);
