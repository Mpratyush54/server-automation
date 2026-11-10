import type { TelemetryConfig } from './telemetry';
import http from 'http';
import https from 'https';
import { randomBytes } from 'crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_BATCHES = 16;
export function retryDelay(attempt: number, header?: string, now = Date.now()): number {
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(delay)) return Math.max(0, delay);
  }
  return Math.min(30000, 1000 * 2 ** attempt) * (.5 + Math.random());
}
type Batch = { path: string; body: Buffer; contentType: string; encoding?: string; attempts: number; ready: number };

/** Private loopback transport shared by OTLP exporters and native Pyroscope clients.
 * At most 16 batches / 8 MiB, one in flight, three attempts. Never forwards arbitrary URLs.
 */
export class TelemetryRelay {
  dropped = 0;
  port = 0;
  private server?: http.Server;
  private queue: Batch[] = [];
  private bytes = 0;
  private busy = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: http.ClientRequest;
  private prefix = '/' + randomBytes(24).toString('hex');
  constructor(private config: () => TelemetryConfig | undefined) {}
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const path = (req.url || '').slice(this.prefix.length);
      if (req.method !== 'POST' || !req.url?.startsWith(this.prefix + '/') || !/^\/(v1\/(traces|metrics|logs)|pyroscope\/ingest)(\?|$)/.test(path)) {
        res.writeHead(404).end(); return;
      }
      if (this.queue.length >= MAX_BATCHES || this.bytes >= MAX_BYTES) {
        this.dropped++; req.resume(); res.writeHead(202).end(); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_BYTES) chunks.push(chunk);
      });
      req.on('error', () => { this.dropped++; });
      req.on('end', () => {
        if (size > MAX_BYTES || this.bytes + size > MAX_BYTES || this.queue.length >= MAX_BATCHES || this.stopped) this.dropped++;
        else {
          this.queue.push({ path, body: Buffer.concat(chunks), contentType: req.headers['content-type'] || 'application/octet-stream', encoding: req.headers['content-encoding'], attempts: 0, ready: 0 });
          this.bytes += size;
          void this.pump();
        }
        res.writeHead(202).end();
      });
    });
    this.server.maxConnections = 4;
    this.server.requestTimeout = 5000;
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
    this.server.unref();
    this.port = (this.server.address() as any).port;
    return `http://127.0.0.1:${this.port}${this.prefix}`;
  }
  private async pump(): Promise<void> {
    if (this.busy || this.stopped || !this.queue.length) return;
    const batch = this.queue[0];
    const delay = batch.ready - Date.now();
    if (delay > 0) {
      this.timer = setTimeout(() => { void this.pump(); }, Math.min(delay, 2147483647));
      this.timer.unref(); return;
    }
    this.busy = true;
    const cfg = this.config();
    let retry: string | undefined;
    let success = false;
    let retryable = false;
    if (cfg?.enabled && Date.parse(cfg.ingestTokenExpiresAt) > Date.now()) {
      const profile = batch.path.startsWith('/pyroscope/');
      const endpoint = profile ? cfg.profilesEndpoint : cfg.otlpEndpoint;
      if (endpoint) {
        const url = new URL(endpoint.replace(/\/$/, '') + (profile ? batch.path.slice('/pyroscope'.length) : batch.path));
        const send = () => new Promise<void>(resolve => {
          const headers: Record<string, string | number> = { Authorization: `Bearer ${cfg.ingestToken}`, 'Content-Type': batch.contentType, 'Content-Length': batch.body.length };
          if (batch.encoding) headers['Content-Encoding'] = batch.encoding;
          this.request = https.request(url, { method: 'POST', headers, timeout: 5000 }, response => {
            response.resume();
            const status = response.statusCode || 0;
            success = status >= 200 && status < 300;
            retryable = [408, 429, 500, 502, 503, 504].includes(status);
            retry = response.headers['retry-after'] as string | undefined;
            response.on('end', resolve);
            response.on('error', () => { retryable = true; resolve(); });
          });
          this.request.on('timeout', () => this.request?.destroy());
          this.request.on('error', () => { retryable = true; resolve(); });
          this.request.end(batch.body);
        });
        // Collector requests must not recursively generate their own telemetry.
        const { context } = require('@opentelemetry/api');
        const { suppressTracing } = require('@opentelemetry/core');
        await context.with(suppressTracing(context.active()), send);
      }
    }
    batch.attempts++;
    if (this.stopped) { this.busy = false; return; }
    if (!success && retryable && batch.attempts < 3 && !this.stopped) batch.ready = Date.now() + retryDelay(batch.attempts - 1, retry);
    else {
      this.queue.shift(); this.bytes -= batch.body.length;
      if (!success) this.dropped++;
    }
    this.busy = false;
    void this.pump();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.request?.destroy();
    this.dropped += this.queue.length;
    this.queue = [];
    this.bytes = 0;
    this.server?.closeAllConnections();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
  }
}
