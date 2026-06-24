import mongoose, { Schema, Document } from 'mongoose';

export interface IFeatureFlag extends Document {
  projectId: string;
  environmentId: string;
  key: string;
  value: string;
  isEnabled: boolean;
}

const FeatureFlagSchema = new Schema<IFeatureFlag>({
  projectId: { type: String, required: true, index: true },
  environmentId: { type: String, required: true },
  key: { type: String, required: true },
  value: String,
  isEnabled: { type: Boolean, default: true },
}, { collection: 'feature_flags' });

FeatureFlagSchema.index({ projectId: 1, environmentId: 1, key: 1 }, { unique: true });
export const FeatureFlagModel = mongoose.model<IFeatureFlag>('FeatureFlag', FeatureFlagSchema);
