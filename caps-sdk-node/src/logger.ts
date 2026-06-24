import { AxiosInstance } from 'axios';

export class LoggerClient {
  private buffer: any[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private http?: AxiosInstance;
  private projectName?: string;
  private environmentName?: string;
  private serviceName?: string;
  private branch?: string;
  private commitSha?: string;
  private hostname?: string;

  constructor() {
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

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
  }

  info(message: string, metadata?: any): void {
    console.log(`[INFO] ${message}`, metadata || '');
    this.enqueue('INFO', message, metadata);
  }

  warn(message: string, metadata?: any): void {
    console.warn(`[WARN] ${message}`, metadata || '');
    this.enqueue('WARN', message, metadata);
  }

  error(message: string, metadata?: any): void {
    console.error(`[ERROR] ${message}`, metadata || '');
    this.enqueue('ERROR', message, metadata);
  }

  debug(message: string, metadata?: any): void {
    console.debug(`[DEBUG] ${message}`, metadata || '');
    this.enqueue('DEBUG', message, metadata);
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
    if (this.buffer.length >= 50) this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.http) return;
    const batch = this.buffer.splice(0);
    try {
      await this.http.post('/api/sdk/logs', { logs: batch });
    } catch (err: any) {
      console.error('[caps] Log forward error (silent):', err.message);
      this.buffer.unshift(...batch);
    }
  }

  stop(): void {
    clearInterval(this.flushInterval);
    this.flush();
  }
}

export const logger = new LoggerClient();
export default logger;
