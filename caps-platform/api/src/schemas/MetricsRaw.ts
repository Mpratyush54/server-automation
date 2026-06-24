import mongoose, { Schema, Document } from 'mongoose';

export interface IMetricsRaw extends Document {
  registrationId: string;
  projectId: string;
  environment: string;
  cpuPct: number;
  memoryMb: number;
  heapMb: number;
  uptimeS: number;
  requestCount: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  errors4xx: number;
  errors5xx: number;
  dbHealth: Record<string, string>;
  timestamp: Date;
}

const MetricsRawSchema = new Schema<IMetricsRaw>({
  registrationId: String,
  projectId: { type: String, required: true, index: true },
  environment: String,
  cpuPct: Number,
  memoryMb: Number,
  heapMb: Number,
  uptimeS: Number,
  requestCount: Number,
  avgResponseMs: Number,
  p95ResponseMs: Number,
  errors4xx: Number,
  errors5xx: Number,
  dbHealth: { type: Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
}, { collection: 'metrics_raw' });

MetricsRawSchema.index({ timestamp: -1 }, { expireAfterSeconds: 604800 });
MetricsRawSchema.index({ projectId: 1, timestamp: -1 });
export const MetricsRawModel = mongoose.model<IMetricsRaw>('MetricsRaw', MetricsRawSchema);
