import mongoose, { Schema, Document } from 'mongoose';

export interface IApiMetric extends Document {
  projectId: string;
  route: string;         // normalized route e.g. /users/:id
  method: string;        // GET POST PUT DELETE PATCH
  statusCode: number;
  durationMs: number;
  memoryDeltaBytes: number;
  sdkVersion?: string;
  environment: string;
  timestamp: Date;
}

const ApiMetricSchema = new Schema<IApiMetric>({
  projectId: { type: String, required: true, index: true },
  route: { type: String, required: true },
  method: { type: String, required: true },
  statusCode: Number,
  durationMs: Number,
  memoryDeltaBytes: Number,
  sdkVersion: String,
  environment: String,
  timestamp: { type: Date, default: Date.now },
}, { collection: 'api_metrics' });

ApiMetricSchema.index({ timestamp: -1 }, { expireAfterSeconds: 2592000 }); // 30 days
ApiMetricSchema.index({ projectId: 1, route: 1, timestamp: -1 });
export const ApiMetricModel = mongoose.model<IApiMetric>('ApiMetric', ApiMetricSchema);
