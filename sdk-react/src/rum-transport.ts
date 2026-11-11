/**
 * Small Faro transport for the Platform collector (replaces Faro's FetchTransport,
 * ~8 KB gzip, to stay inside the SDK bundle budget).
 *
 * Backpressure contract: on 429/503 honour `Retry-After`, otherwise exponential
 * backoff with jitter; batches wait in a bounded queue and are dropped (and
 * counted) when it is full. Never throws and never blocks the host app.
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import type { ErrorEvent } from './error-event';
import { BaseTransport, getTransportBody, VERSION } from '@grafana/faro-core';

export interface PlatformTransportOptions {
  url: string;
  token: string;
  errorsUrl?: string | null;
  release?: string;
  /** Current session replay id, attached to error events (`replayId`, #40). */
  replayId?: () => string | undefined;
  /** Max batches waiting while the collector is unavailable (default 30). */
  maxQueue?: number;
  /** Backoff cap in ms (default 60 s). */
  maxBackoffMs?: number;
  fetchImpl?: (url: string, init: any) => Promise<{ status: number; headers?: { get(name: string): string | null } }>;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const KEEPALIVE_LIMIT = 60_000; // browsers cap keepalive bodies at 64 KiB

/** Parse `Retry-After` (seconds or HTTP date) into a delay in ms. */
export function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class PlatformTransport extends BaseTransport {
  readonly name = 'platform-rum-transport';
  readonly version = VERSION;
  /** Batches dropped because the queue was full. */
  dropped = 0;
  private queue: string[] = [];
  private breadcrumbs: NonNullable<ErrorEvent['breadcrumbs']> = [];
  private blockedUntil = 0;
  private failures = 0;
  private inFlight = false;
  private timer: unknown = null;
  private readonly fetchImpl: NonNullable<PlatformTransportOptions['fetchImpl']>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly opts: PlatformTransportOptions) {
    super();
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
    this.fetchImpl = f ?? (() => Promise.reject(new Error('fetch unavailable')));
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  send(items: any): void {
    try {
      const list = Array.isArray(items) ? items : [items];
      if (!list.length) return;
      if (this.opts.errorsUrl) for (const item of list.slice(0, 20)) {
        if (item.type !== 'exception') {
          if (item.type === 'event' || item.type === 'log') {
            this.breadcrumbs.push({ message: String(item.payload?.name || item.payload?.message || item.type).slice(0, 1000), category: item.type });
            if (this.breadcrumbs.length > 20) this.breadcrumbs.shift();
          }
          continue;
        }
        const p = item.payload || {}, meta = item.meta || {};
        const event: ErrorEvent = {
          eventId: globalThis.crypto?.randomUUID?.(), type: String(p.type || 'Error').slice(0, 200),
          message: String(p.value || p.message || 'Unknown error').slice(0, 8000),
          release: this.opts.release || meta.app?.version || 'unknown',
          environment: meta.app?.environment || 'production',
          sessionId: meta.session?.id, userId: meta.user?.id, replayId: this.opts.replayId?.(), breadcrumbs: [...this.breadcrumbs],
          traceId: p.trace?.trace_id,
          frames: (p.stacktrace?.frames || []).slice(0, 100).map((f: any) => ({
            file: String(f.filename || f.file || '<unknown>'), function: f.function,
            line: Math.max(1, Number(f.lineno ?? f.line) || 1),
            column: Math.max(0, (Number(f.colno ?? f.column) || 1) - 1),
          })),
        };
        void this.fetchImpl(this.opts.errorsUrl, { method: 'POST', credentials: 'omit',
          headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(event), keepalive: true }).catch(() => {});
      }
      this.enqueue(JSON.stringify(getTransportBody(list)));
      this.pump();
    } catch {
      /* never throw into Faro / the app */
    }
  }

  override isBatched(): boolean {
    return true;
  }

  override getIgnoreUrls(): Array<string | RegExp> {
    return [this.opts.url, ...(this.opts.errorsUrl ? [this.opts.errorsUrl] : [])];
  }

  private enqueue(body: string): void {
    const max = this.opts.maxQueue ?? 30;
    if (this.queue.length >= max) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(body);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  private backoff(retryAfter: number | null): void {
    this.failures++;
    const cap = this.opts.maxBackoffMs ?? 60_000;
    const exp = Math.min(cap, 1000 * 2 ** (this.failures - 1));
    const delay = retryAfter ?? exp / 2 + (this.random() * exp) / 2; // full jitter on the upper half
    this.blockedUntil = this.now() + delay;
    this.schedule(delay);
  }

  private pump(): void {
    if (this.inFlight || !this.queue.length) return;
    const wait = this.blockedUntil - this.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const body = this.queue[0];
    this.inFlight = true;
    let request: Promise<{ status: number; headers?: { get(name: string): string | null } }>;
    try {
      request = this.fetchImpl(this.opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
        body,
        keepalive: body.length < KEEPALIVE_LIMIT,
        credentials: 'omit',
      });
    } catch (err) {
      request = Promise.reject(err);
    }
    request
      .then(
        (res) => {
          const status = res?.status ?? 0;
          if (status === 429 || status === 503) {
            this.backoff(retryAfterMs(res.headers?.get('Retry-After'), this.now()));
          } else if (status >= 500 || status === 0) {
            this.backoff(null);
          } else {
            // 2xx delivered; other 4xx are permanent (bad token/payload): drop, do not retry.
            this.queue.shift();
            if (status >= 400) this.dropped++;
            this.failures = 0;
          }
        },
        () => this.backoff(null),
      )
      .then(() => {
        this.inFlight = false;
        if (this.blockedUntil <= this.now()) this.pump();
      });
  }
}
