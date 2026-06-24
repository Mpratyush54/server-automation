import mongoose, { Schema, Document } from 'mongoose';

export interface ISdkEvent extends Document {
  event: string;
  registrationId: string;
  projectId: string;
  payloadSummary: Record<string, any>;
  timestamp: Date;
}

const SdkEventSchema = new Schema<ISdkEvent>({
  event: { type: String, required: true },
  registrationId: String,
  projectId: { type: String, index: true },
  payloadSummary: { type: Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now },
}, { collection: 'sdk_events' });

SdkEventSchema.index({ timestamp: -1 }, { expireAfterSeconds: 259200 });
export const SdkEventModel = mongoose.model<ISdkEvent>('SdkEvent', SdkEventSchema);
