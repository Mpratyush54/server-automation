import { AxiosInstance } from 'axios';
import os from 'os';

// Minimal compatible interfaces — works with Express, Fastify, NestJS, raw http.IncomingMessage
export interface IncomingReq {
  path?: string;
  url?: string;
  method: string;
}

export interface OutgoingRes {
  statusCode: number;
  on(event: 'finish', listener: () => void): this;
}

export type NextFn = (err?: any) => void;

// Normalize a URL path — strips IDs/UUIDs/numbers and replaces with :id
export function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '')  // strip query string
    .replace(/\/+$/, '') || '/';
}

function getCpuUsagePercent(): Promise<number> {
  return new Promise((resolve) => {
    const cpusBefore = os.cpus();
    setTimeout(() => {
      const cpusAfter = os.cpus();
      let idle = 0, total = 0;
      cpusAfter.forEach((cpu, i) => {
        const before = cpusBefore[i];
        const idleDiff = (cpu.times.idle - before.times.idle);
        const totalDiff = Object.values(cpu.times).reduce((a, b) => a + b, 0)
          - Object.values(before.times).reduce((a, b) => a + b, 0);
        idle += idleDiff;
        total += totalDiff;
      });
      resolve(total > 0 ? Math.round((1 - idle / total) * 100) : 0);
    }, 100);
  });
}

export interface ApiMetricEntry {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  memoryDeltaBytes: number;
  environment: string;
  timestamp: string;
}

export class MetricsTracker {
  private buffer: ApiMetricEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval>;
  private http?: AxiosInstance;
  private projectId?: string;
  private environment?: string;
  private sdkVersion = '1.0.0';

  constructor() {
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  configure(http: AxiosInstance, projectId: string, environment: string) {
    this.http = http;
    this.projectId = projectId;
    this.environment = environment;
  }

  // Express middleware — zero latency, attaches to res.on('finish')
  middleware() {
    return (req: IncomingReq, res: OutgoingRes, next: NextFn) => {
      const startTime = process.hrtime.bigint();
      const memBefore = process.memoryUsage().heapUsed;

      res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - startTime);
        const durationMs = Math.round(durationNs / 1_000_000);
        const memAfter = process.memoryUsage().heapUsed;
        const memDelta = memAfter - memBefore;
        const route = normalizePath(req.path || req.url || '/');

        this.record({
          route,
          method: req.method,
          statusCode: res.statusCode,
          durationMs,
          memoryDeltaBytes: memDelta,
          environment: this.environment || 'production',
          timestamp: new Date().toISOString(),
        });
      });

      next();
    };
  }

  record(entry: ApiMetricEntry) {
    this.buffer.push(entry);
    if (this.buffer.length >= 100) this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.http || !this.projectId) return;
    const batch = this.buffer.splice(0);
    try {
      await this.http.post('/api/sdk/api-metrics', {
        projectId: this.projectId,
        metrics: batch,
      });
    } catch {
      // Re-queue up to 500 entries max to avoid memory bloat
      if (this.buffer.length < 500) this.buffer.unshift(...batch.slice(0, 50));
    }
  }

  stop(): void {
    clearInterval(this.flushInterval);
    this.flush();
  }
}

export const metricsTracker = new MetricsTracker();
