/** Version 1 wire contract, shared verbatim with the TypeScript SDKs. Lines are
 * one-based, columns zero-based; frames are ordered innermost first. */
export interface ErrorFrame { file: string; line: number; column: number; function?: string }
export interface ErrorEvent {
  eventId?: string;
  type: string;
  message: string;
  frames: ErrorFrame[];
  release: string;
  environment: string;
  traceId?: string;
  userId?: string;
  sessionId?: string;
  replayId?: string;
  breadcrumbs?: Array<{ message: string; timestamp?: string; category?: string }>;
}
