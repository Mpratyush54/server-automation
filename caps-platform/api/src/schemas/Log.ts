import mongoose, { Schema, Document } from 'mongoose';

export interface ILog extends Document {
  projectId: string;
  environment: string;
  branch: string;
  commitSha: string;
  hostname: string;
  level: string;
  message: string;
  fields: Record<string, any>;
  timestamp: Date;
}

const LogSchema = new Schema<ILog>({
  projectId: { type: String, required: true, index: true },
  environment: String,
  branch: String,
  commitSha: String,
  hostname: String,
  level: { type: String, required: true },
  message: { type: String, required: true },
  fields: { type: Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
}, { collection: 'logs' });

LogSchema.index({ timestamp: -1 }, { expireAfterSeconds: 2592000 });
LogSchema.index({ projectId: 1, environment: 1, timestamp: -1 });
export const LogModel = mongoose.model<ILog>('Log', LogSchema);
