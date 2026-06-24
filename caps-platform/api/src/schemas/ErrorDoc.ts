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
}, { collection: 'errors' });

ErrorDocSchema.index({ projectId: 1, errorType: 1 });
ErrorDocSchema.index({ lastSeen: -1 });
export const ErrorDocModel = mongoose.model<IErrorDoc>('ErrorDoc', ErrorDocSchema);
