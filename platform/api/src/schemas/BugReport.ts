import mongoose, { Schema, Document } from 'mongoose';

export interface IBugReport extends Document {
  projectId: string;
  environment: string;
  description: string;
  category: string;
  consoleLogs: string[];
  networkTimeline: any[];
  screenshotBase64?: string;
  browserInfo: Record<string, any>;
  appState?: Record<string, any>;
  clickupTaskId?: string;
  gitlabIssueId?: number;
  githubIssueNumber?: number;
  timestamp: Date;
}

const BugReportSchema = new Schema<IBugReport>({
  projectId: { type: String, required: true, index: true },
  environment: String,
  description: { type: String, required: true },
  category: String,
  consoleLogs: [String],
  networkTimeline: [Schema.Types.Mixed],
  screenshotBase64: String,
  browserInfo: Schema.Types.Mixed,
  appState: Schema.Types.Mixed,
  clickupTaskId: String,
  gitlabIssueId: Number,
  githubIssueNumber: Number,
  timestamp: { type: Date, default: Date.now },
}, { collection: 'bug_reports' });

BugReportSchema.index({ projectId: 1, timestamp: -1 });
export const BugReportModel = mongoose.model<IBugReport>('BugReport', BugReportSchema);
