import mongoose, { Schema, Document } from 'mongoose';

export interface IMetricsHourly extends Document {
  projectId: string;
  environment: string;
  serviceName: string;
  avgCpu: number;
  avgMemory: number;
  avgLatency: number;
  avgErrorRate: number;
  totalRequests: number;
  hour: Date;
}

const MetricsHourlySchema = new Schema<IMetricsHourly>({
  projectId: { type: String, required: true, index: true },
  environment: String,
  serviceName: String,
  avgCpu: Number,
  avgMemory: Number,
  avgLatency: Number,
  avgErrorRate: Number,
  totalRequests: Number,
  hour: { type: Date, default: Date.now },
}, { collection: 'metrics_hourly' });

MetricsHourlySchema.index({ projectId: 1, hour: -1 });
MetricsHourlySchema.index({ hour: 1 }, { expireAfterSeconds: 7776000 });
export const MetricsHourlyModel = mongoose.model<IMetricsHourly>('MetricsHourly', MetricsHourlySchema);
