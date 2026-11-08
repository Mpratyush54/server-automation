import { AxiosInstance } from 'axios';
import { runWithoutCapture } from './console-capture';

/** Max log entries held in memory while the Platform API is unreachable (oldest dropped first). */
export const MAX_LOG_BUFFER = 500;

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export class LoggerClient {
  private buffer: any[] = [];
  private flushInterval?: ReturnType<typeof setInterval>;
  private http?: AxiosInstance;
  private projectName?: string;
  private environmentName?: string;
  private serviceName?: string;
  private branch?: string;
  private commitSha?: string;
  private hostname?: string;

  configure(
    http: AxiosInstance,
    projectName: string,
    environmentName: string,
    serviceName: string,
    branch?: string,
    commitSha?: string,
    hostname?: string
  ) {
    this.http = http;
    this.projectName = projectName;
    this.environmentName = environmentName;
    this.serviceName = serviceName;
    this.branch = branch;
    this.commitSha = commitSha;
    this.hostname = hostname || 'localhost';
    this.startFlushTimer();
  }

  // Started lazily (not at import time) and unref'd so it never keeps the process alive.
  private startFlushTimer(): void {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => this.flush(), 5000);
    (this.flushInterval as any).unref?.();
  }

  info(message: string, metadata?: any): void {
    runWithoutCapture(() => console.log(`[INFO] ${message}`, metadata || ''));
    this.enqueue('INFO', message, metadata);
  }

  warn(message: string, metadata?: any): void {
    runWithoutCapture(() => console.warn(`[WARN] ${message}`, metadata || ''));
    this.enqueue('WARN', message, metadata);
  }

  error(message: string, metadata?: any): void {
    runWithoutCapture(() => console.error(`[ERROR] ${message}`, metadata || ''));
    this.enqueue('ERROR', message, metadata);
  }

  debug(message: string, metadata?: any): void {
    runWithoutCapture(() => console.debug(`[DEBUG] ${message}`, metadata || ''));
    this.enqueue('DEBUG', message, metadata);
  }

  /** Enqueue an entry without echoing it to the console (used by captureConsole). */
  record(level: LogLevel, message: string, metadata?: any): void {
    this.enqueue(level, message, metadata);
  }

  private enqueue(level: string, message: string, metadata?: any): void {
    if (!this.http || !this.projectName) return;
    this.buffer.push({
      projectId: this.projectName,
      environment: this.environmentName,
      serviceName: this.serviceName,
      branch: this.branch,
      commitSha: this.commitSha,
      hostname: this.hostname,
      level,
      message,
      metadata,
      timestamp: new Date().toISOString(),
    });
    if (this.buffer.length > MAX_LOG_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_LOG_BUFFER);
    if (this.buffer.length >= 50) this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.http) return;
    const batch = this.buffer.splice(0);
    try {
      await this.http.post('/api/sdk/logs', { logs: batch });
    } catch (err: any) {
      runWithoutCapture(() => console.error('[platform] Log forward error (silent):', err.message));
      // Re-queue, but never hold more than MAX_LOG_BUFFER entries (drop oldest).
      this.buffer.unshift(...batch);
      if (this.buffer.length > MAX_LOG_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_LOG_BUFFER);
    }
  }

  /** Number of entries waiting to be forwarded. */
  get pending(): number {
    return this.buffer.length;
  }

  stop(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
    this.flushInterval = undefined;
    this.flush();
  }
}

export const logger = new LoggerClient();
export default logger;
