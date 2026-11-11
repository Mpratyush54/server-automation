/**
 * Privacy-first session replay (#40): decisions, consent, chunking and upload.
 *
 * This module is small and has no rrweb code. It is loaded lazily from rum.ts
 * (`import('./rum-replay')`) only when the app sets `rum.replay`. rrweb and the
 * gzip encoder live in `rum-replay-record.ts`, which is downloaded only after
 * the session is sampled in AND replay consent is given, so pages without
 * consent never fetch the recorder.
 *
 * Defaults are privacy-first: every input value is masked, visible text is run
 * through the same redaction as RUM payloads (e-mails, tokens, credentials),
 * elements with `platform-block` / `data-platform-block` are not recorded at all,
 * and with `requireConsent` (default) nothing is recorded until
 * `setConsent({ replay: true })` is called or consent was recorded server-side.
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import { SENSITIVE_INPUT_SELECTOR } from './rum-deps';
import {
  addRumHook,
  getRum,
  isDoNotTrack,
  normalizeRouteName,
  PlatformTelemetryConfig,
  sanitizeUrl,
  scrubText,
  setReplayIdForErrors,
} from './rum';

export interface PlatformReplayOptions {
  /** Share of sessions recorded in full (0..1). Default 0.1. */
  sampleRate?: number;
  /**
   * Share of the remaining sessions that keep the last `bufferSeconds` in memory
   * (never uploaded) and upload them only when an error happens. Default 1.
   */
  onErrorSampleRate?: number;
  /** Seconds kept by the on-error buffer (10..300). Default 60. */
  bufferSeconds?: number;
  /**
   * Record only after consent: `setConsent({ replay: true })` on this device, or a
   * consent recorded server-side for the subject (`PUT /api/sdk/privacy/consent`).
   * Default true. An explicit `setConsent({ replay: false })` always wins.
   */
  requireConsent?: boolean;
  /** Mask every input/textarea/select value (default true). Passwords are always masked. */
  maskAllInputs?: boolean;
  /**
   * Visible text: `pii` (default) redacts e-mails, tokens and credentials;
   * `all` replaces every character with `*`; `none` records text as is.
   * Elements matching the mask class/selector are always fully masked.
   */
  maskText?: 'pii' | 'all' | 'none';
  /** Class of elements that are not recorded at all (default `platform-block`; `rr-block` also works). */
  blockClass?: string;
  /** Extra CSS selector of elements that are not recorded (`[data-platform-block]` always applies). */
  blockSelector?: string;
  /** Class whose text is fully masked (default `platform-mask`; `rr-mask` also works). */
  maskTextClass?: string;
  /** Extra CSS selector whose text is fully masked (`[data-platform-mask]` always applies). */
  maskTextSelector?: string;
  /** Record network markers (method, redacted URL, status, duration, trace id). Default true. */
  captureNetwork?: boolean;
  /** Take a DOM snapshot after SPA route changes (needed for per-page heatmap backgrounds). Default true. */
  snapshotOnNavigation?: boolean;
  /** Replay API base (default `telemetry.replayEndpoint`, else `<apiBase>/api/sdk/replay`). */
  endpoint?: string;
  /** Application user id attached to the session (an opaque id, never an e-mail). */
  userId?: string;
  /** Upload interval in ms (default 5000). */
  flushIntervalMs?: number;
  /** Raw (uncompressed) bytes that trigger an upload before the interval (default 65536). */
  maxChunkBytes?: number;
}

export type ReplayMode = 'session' | 'buffer';
export type ReplaySkipReason =
  | 'not-configured'
  | 'no-browser'
  | 'no-endpoint'
  | 'do-not-track'
  | 'not-sampled'
  | 'no-consent'
  | 'disabled';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

export interface ReplayEnvironment {
  win?: any;
  nav?: any;
  /** sessionStorage (session id, sequence, sampling decision). */
  session?: StorageLike | null;
  /** localStorage (consent decision, anonymous subject id). */
  local?: StorageLike | null;
  random?: () => number;
  now?: () => number;
  fetchImpl?: (url: string, init: any) => Promise<{ status: number; ok?: boolean; json?: () => Promise<any>; headers?: { get(name: string): string | null } }>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** What the recorder module exports (rum-replay-record.ts); injectable for tests. */
export interface ReplayRecorderModule {
  startRecorder(config: Record<string, unknown>, emit: (event: any, isCheckout?: boolean) => void): ReplayRecorder;
  gzip(text: string): Uint8Array;
}

export interface ReplayRecorder {
  stop(): void;
  addCustomEvent(tag: string, payload: unknown): void;
  takeFullSnapshot(isCheckout?: boolean): void;
}

export interface ReplayHandle {
  sessionId: string;
  mode: ReplayMode;
  stop(): void;
}

// ---------------------------------------------------------------- privacy defaults

const BLOCK_SELECTOR = '[data-platform-block]';
const MASK_SELECTOR = '[data-platform-mask]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classRegExp(custom: string | undefined, fallback: string, rrweb: string): RegExp {
  const names = [custom || fallback, rrweb].map(escapeRegExp).join('|');
  return new RegExp(`^(?:${names})$`);
}

/** Replace every non-space character with `*` (keeps layout, removes content). */
export function maskAll(text: string): string {
  return text.replace(/\S/g, '*');
}

/**
 * rrweb `record()` options for a replay configuration: masking, blocking, slim DOM,
 * sampling of high-frequency events. No canvas, fonts, images or cross-origin iframes
 * are captured. Exported for tests (the recorder applies it verbatim).
 */
export function buildRecordOptions(options: PlatformReplayOptions = {}, mode: ReplayMode = 'session'): Record<string, unknown> {
  const maskTextClass = classRegExp(options.maskTextClass, 'platform-mask', 'rr-mask');
  const explicitMask = [MASK_SELECTOR, SENSITIVE_INPUT_SELECTOR, options.maskTextSelector].filter(Boolean).join(', ');
  const maskClassSelector = `.${options.maskTextClass || 'platform-mask'}, .rr-mask`;
  const textMode = options.maskText || 'pii';
  const fullyMasked = (el: any): boolean => {
    try {
      return !!el && typeof el.closest === 'function' && !!(el.closest(explicitMask) || el.closest(maskClassSelector));
    } catch {
      return true; // invalid custom selector: fail closed
    }
  };
  const bufferMs = clampNumber(options.bufferSeconds, 60, 10, 300) * 1000;
  return {
    maskAllInputs: options.maskAllInputs !== false,
    maskInputOptions: { password: true },
    maskInputFn: (text: string) => '*'.repeat(Math.min(String(text || '').length, 24)),
    blockClass: classRegExp(options.blockClass, 'platform-block', 'rr-block'),
    blockSelector: [BLOCK_SELECTOR, options.blockSelector].filter(Boolean).join(', '),
    maskTextClass,
    // In `pii`/`all` mode every text node goes through maskTextFn; in `none` only explicit ones.
    maskTextSelector: textMode === 'none' ? explicitMask : '*',
    maskTextFn: (text: string, el: any) => {
      if (textMode !== 'pii' || fullyMasked(el)) return maskAll(text);
      return scrubText(text);
    },
    slimDOMOptions: 'all',
    inlineStylesheet: true,
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    recordCrossOriginIframes: false,
    sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last' },
    // Buffer mode trims to the last checkout; session mode re-snapshots every 10 min (seeking).
    checkoutEveryNms: mode === 'buffer' ? bufferMs : 10 * 60 * 1000,
    errorHandler: () => true,
  };
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------- session + sampling

const SESSION_KEY = 'platform.replay.session';
const CONSENT_KEY = 'platform.consent.replay';
const SUBJECT_KEY = 'platform.replay.subject';
export const REPLAY_IDLE_MS = 30 * 60 * 1000;
export const REPLAY_MAX_SESSION_MS = 4 * 60 * 60 * 1000;

export interface ReplaySessionState {
  id: string;
  seq: number;
  startedAt: number;
  lastActivity: number;
  mode: ReplayMode | 'off';
}

function randomId(random: () => number): string {
  const c: any = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
}

/** Sticky per-session decision: full recording, on-error buffer, or nothing. */
export function decideReplayMode(sampleRate: number, onErrorSampleRate: number, random: () => number = Math.random): ReplayMode | 'off' {
  const s = clampNumber(sampleRate, 0.1, 0, 1);
  const e = clampNumber(onErrorSampleRate, 1, 0, 1);
  if (s > 0 && random() < s) return 'session';
  if (e > 0 && random() < e) return 'buffer';
  return 'off';
}

/**
 * Current replay session for this tab (sessionStorage): reused across reloads until
 * 30 min idle or 4 h total, then a new id, sequence and sampling decision.
 */
export function loadReplaySession(
  options: PlatformReplayOptions,
  storage: StorageLike | null | undefined,
  now: number,
  random: () => number = Math.random,
): ReplaySessionState {
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as ReplaySessionState;
      if (
        s && typeof s.id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s.id) &&
        Number.isInteger(s.seq) && s.seq >= 0 &&
        now - s.lastActivity < REPLAY_IDLE_MS && now - s.startedAt < REPLAY_MAX_SESSION_MS &&
        (s.mode === 'session' || s.mode === 'buffer' || s.mode === 'off')
      ) {
        return s;
      }
    }
  } catch {
    /* corrupt or blocked storage: start over */
  }
  const fresh: ReplaySessionState = {
    id: randomId(random),
    seq: 0,
    startedAt: now,
    lastActivity: now,
    mode: decideReplayMode(options.sampleRate ?? 0.1, options.onErrorSampleRate ?? 1, random),
  };
  saveReplaySession(storage, fresh);
  return fresh;
}

export function saveReplaySession(storage: StorageLike | null | undefined, s: ReplaySessionState): void {
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked */
  }
}

// ---------------------------------------------------------------- consent

/** Consent stored on this device: true / false, or null when never asked. */
export function readLocalConsent(storage: StorageLike | null | undefined): boolean | null {
  try {
    const v = storage?.getItem(CONSENT_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Anonymous, random subject id for consent / GDPR delete (never derived from user data). */
export function subjectIdFor(options: PlatformReplayOptions, storage: StorageLike | null | undefined, random: () => number = Math.random): string {
  const user = typeof options.userId === 'string' ? options.userId.trim() : '';
  if (/^[A-Za-z0-9_.:-]{1,128}$/.test(user)) return user;
  try {
    const prev = storage?.getItem(SUBJECT_KEY);
    if (prev && /^anon-[A-Za-z0-9-]{8,64}$/.test(prev)) return prev;
  } catch {
    /* blocked */
  }
  const id = `anon-${randomId(random)}`;
  try {
    storage?.setItem(SUBJECT_KEY, id);
  } catch {
    /* blocked: consent will not persist across sessions */
  }
  return id;
}

/**
 * Whether recording may start. An explicit local "no" always wins; with
 * `requireConsent` a local "yes" or a server-recorded consent is required.
 * Server errors count as "no" (fail closed).
 */
export async function resolveReplayConsent(opts: {
  requireConsent: boolean;
  local: boolean | null;
  askServer: () => Promise<boolean>;
}): Promise<boolean> {
  if (opts.local === false) return false;
  if (!opts.requireConsent) return true;
  if (opts.local === true) return true;
  try {
    return (await opts.askServer()) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- chunking

/** One upload unit: serialized rrweb events plus aggregated metadata. */
export interface ReplayChunk {
  events: string[];
  startedAt: number;
  endedAt: number;
  bytes: number;
  pages: string[];
  errors: number;
  networkErrors: number;
  traceIds: string[];
}

interface Pending extends ReplayChunk {
  timer: unknown;
}

function emptyChunk(): Pending {
  return { events: [], startedAt: 0, endedAt: 0, bytes: 0, pages: [], errors: 0, networkErrors: 0, traceIds: [], timer: null };
}

/**
 * Groups events into chunks of at most `maxBytes` raw JSON (default 64 KiB) or
 * `flushIntervalMs` (default 5 s), whichever comes first. A single event larger
 * than the limit (a big full snapshot) becomes its own chunk.
 */
export class ReplayChunker {
  private cur: Pending = emptyChunk();
  private readonly maxBytes: number;
  private readonly interval: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly onChunk: (chunk: ReplayChunk) => void,
    opts: { maxBytes?: number; flushIntervalMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
  ) {
    this.maxBytes = clampNumber(opts.maxBytes, 64 * 1024, 4 * 1024, 512 * 1024);
    this.interval = clampNumber(opts.flushIntervalMs, 5000, 1000, 60_000);
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as any));
  }

  /** Add one event (already serialized). */
  add(serialized: string, timestamp: number): void {
    if (this.cur.events.length && this.cur.bytes + serialized.length > this.maxBytes) this.flush();
    if (!this.cur.events.length) {
      this.cur.startedAt = timestamp;
      this.cur.timer = this.setTimer(() => this.flush(), this.interval);
    }
    this.cur.events.push(serialized);
    this.cur.bytes += serialized.length + 1;
    this.cur.endedAt = Math.max(this.cur.endedAt, timestamp);
    if (this.cur.bytes >= this.maxBytes) this.flush();
  }

  /** Metadata for the chunk being built. */
  note(kind: 'page' | 'error' | 'networkError' | 'trace', value?: string): void {
    if (kind === 'error') this.cur.errors++;
    else if (kind === 'networkError') this.cur.networkErrors++;
    else if (kind === 'page' && value && !this.cur.pages.includes(value) && this.cur.pages.length < 20) this.cur.pages.push(value);
    else if (kind === 'trace' && value && !this.cur.traceIds.includes(value) && this.cur.traceIds.length < 50) this.cur.traceIds.push(value);
  }

  get size(): number {
    return this.cur.events.length;
  }

  /**
   * Emit the open chunk. `maxPieceBytes` splits it into several chunks of at most
   * that many raw bytes (page hide: each piece must fit a keepalive request); the
   * metadata travels with the first piece, a single oversized event stays whole.
   */
  flush(maxPieceBytes?: number): void {
    const chunk = this.cur;
    if (chunk.timer) this.clearTimer(chunk.timer);
    if (!chunk.events.length) {
      // keep metadata noted before the first event
      return;
    }
    this.cur = emptyChunk();
    const { timer: _t, ...out } = chunk;
    if (!maxPieceBytes || out.bytes <= maxPieceBytes) {
      this.onChunk(out);
      return;
    }
    let piece: ReplayChunk = { ...out, events: [], bytes: 0 };
    for (const ev of out.events) {
      if (piece.events.length && piece.bytes + ev.length + 1 > maxPieceBytes) {
        this.onChunk(piece);
        piece = { events: [], startedAt: out.startedAt, endedAt: out.endedAt, bytes: 0, pages: [], errors: 0, networkErrors: 0, traceIds: [] };
      }
      piece.events.push(ev);
      piece.bytes += ev.length + 1;
    }
    this.onChunk(piece);
  }
}

/**
 * On-error buffer: keeps events since the previous rrweb checkout (so between
 * `bufferSeconds` and 2x of history, always starting with a full snapshot).
 */
export class ReplayBuffer {
  private prev: Array<[string, number]> = [];
  private cur: Array<[string, number]> = [];

  add(serialized: string, timestamp: number, isCheckout: boolean): void {
    if (isCheckout) {
      this.prev = this.cur;
      this.cur = [];
    }
    this.cur.push([serialized, timestamp]);
  }

  /** All buffered events, oldest first; empties the buffer. */
  drain(): Array<[string, number]> {
    const out = this.prev.concat(this.cur);
    this.prev = [];
    this.cur = [];
    return out;
  }

  get length(): number {
    return this.prev.length + this.cur.length;
  }
}

export interface EnvelopeMeta {
  sessionId: string;
  seq: number;
  mode: ReplayMode;
  page: string;
  subjectId: string;
  userId?: string;
  environment?: string;
  release?: string;
  app?: string;
  viewport?: { w: number; h: number };
}

/** The JSON document that is gzipped and uploaded (wire format v1). */
export function buildEnvelope(meta: EnvelopeMeta, chunk: ReplayChunk): string {
  const head = {
    v: 1,
    ...meta,
    startedAt: Math.round(chunk.startedAt),
    endedAt: Math.round(Math.max(chunk.endedAt, chunk.startedAt)),
    pages: chunk.pages,
    errors: chunk.errors,
    networkErrors: chunk.networkErrors,
    traceIds: chunk.traceIds,
  };
  const json = JSON.stringify(head);
  return `${json.slice(0, -1)},"events":[${chunk.events.join(',')}]}`;
}

// ---------------------------------------------------------------- upload

export interface ReplayUploaderOptions {
  url: string;
  token: string;
  compress: (text: string) => Uint8Array;
  fetchImpl?: ReplayEnvironment['fetchImpl'];
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Compressed bytes allowed to wait while the API is unavailable (default 4 MiB). */
  maxQueueBytes?: number;
  maxBackoffMs?: number;
  /** Called on a permanent refusal (401/403/404/410: invalid token, replay disabled). */
  onFatal?: (status: number) => void;
}

const KEEPALIVE_BUDGET = 60_000; // browsers cap in-flight keepalive bodies at 64 KiB per page
/** Raw bytes per chunk flushed on page hide, so each compressed piece fits a keepalive request. */
export const UNLOAD_PIECE_BYTES = 48 * 1024;

interface QueuedChunk {
  seq: number;
  body: Uint8Array;
  delivered?: boolean;
}

function retryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * Sequential uploader: one request in flight, retry with exponential backoff and
 * jitter (honours `Retry-After` on 429/503), bounded queue (oldest dropped and
 * counted), `keepalive` for the final flush on page hide. Never throws.
 *
 * Page hide: the final chunks are enqueued without starting a normal fetch
 * (`enqueue(.., { pump: false })`) and `flushUnload()` sends every queued chunk -
 * including one whose normal fetch is still in flight, which an unload may cancel -
 * with `fetch(.., { keepalive: true })`. The server answers a re-sent chunk with 200
 * and stores it once. `navigator.sendBeacon` is not used: it cannot send the
 * `Authorization` header the replay API requires. Keepalive bodies share a 64 KiB
 * per-page budget; chunks that do not fit stay queued and get a best-effort normal
 * fetch (delivered if the page survives, e.g. it was only hidden).
 */
export class ReplayUploader {
  dropped = 0;
  sent = 0;
  stopped = false;
  private queue: QueuedChunk[] = [];
  private keepaliveBytes = 0;
  private queuedBytes = 0;
  private inFlight = false;
  private failures = 0;
  private blockedUntil = 0;
  private timer: unknown = null;
  private readonly fetchImpl: NonNullable<ReplayEnvironment['fetchImpl']>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly opts: ReplayUploaderOptions) {
    const f = opts.fetchImpl ?? (typeof fetch === 'function' ? (fetch.bind(globalThis) as any) : undefined);
    this.fetchImpl = f ?? (() => Promise.reject(new Error('fetch unavailable')));
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get pending(): number {
    return this.queue.length;
  }

  /** `pump: false` queues without starting a normal request (page hide: `flushUnload` follows). */
  enqueue(seq: number, envelope: string, opts: { pump?: boolean } = {}): void {
    if (this.stopped) return;
    let body: Uint8Array;
    try {
      body = this.opts.compress(envelope);
    } catch {
      this.dropped++;
      return;
    }
    const max = this.opts.maxQueueBytes ?? 4 * 1024 * 1024;
    while (this.queue.length && this.queuedBytes + body.length > max) {
      const old = this.queue.shift()!;
      this.queuedBytes -= old.body.length;
      this.dropped++;
    }
    this.queue.push({ seq, body });
    this.queuedBytes += body.length;
    if (opts.pump !== false) this.pump();
  }

  /**
   * Page is going away: send every queued chunk that fits the keepalive budget with
   * `keepalive`, now - the in-flight head too (its normal fetch may die with the page).
   * What does not fit stays queued and gets a best-effort normal request.
   */
  flushUnload(): void {
    if (this.stopped) return;
    for (let i = 0; i < this.queue.length; ) {
      const item = this.queue[i];
      const size = item.body.length;
      if (this.keepaliveBytes + size > KEEPALIVE_BUDGET) {
        i++; // too big for what is left of the budget; a smaller one may still fit
        continue;
      }
      this.queue.splice(i, 1);
      this.queuedBytes -= size;
      this.keepaliveBytes += size;
      // If the browser refuses the keepalive request (e.g. no keepalive preflight support),
      // put the chunk back: the page may only be hidden, and the normal path retries it.
      let req: Promise<{ status: number }>;
      try {
        req = this.request(item.body, true);
      } catch (err) {
        req = Promise.reject(err);
      }
      req
        .then(
          (res) => {
            const status = res?.status ?? 0;
            if ((status >= 200 && status < 300) || status === 409) this.delivered(item);
            else if (status === 0 || status >= 500 || status === 429) this.requeue(item);
          },
          () => this.requeue(item),
        )
        .then(() => {
          this.keepaliveBytes -= size;
        });
    }
    this.pump(); // leftovers (over the keepalive budget): best effort
  }

  private delivered(item: QueuedChunk): void {
    if (item.delivered) return;
    item.delivered = true;
    this.sent++;
  }

  private requeue(item: QueuedChunk): void {
    if (this.stopped || item.delivered || this.queue.includes(item)) return;
    this.queue.unshift(item);
    this.queuedBytes += item.body.length;
    this.schedule(1000);
  }

  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.queuedBytes = 0;
  }

  private request(body: Uint8Array, keepalive: boolean) {
    return this.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${this.opts.token}` },
      body,
      keepalive: keepalive && body.length < KEEPALIVE_BUDGET,
      credentials: 'omit',
    });
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pump();
    }, ms);
  }

  private backoff(after: number | null): void {
    this.failures++;
    const cap = this.opts.maxBackoffMs ?? 60_000;
    const exp = Math.min(cap, 1000 * 2 ** (this.failures - 1));
    const delay = after ?? exp / 2 + (this.random() * exp) / 2;
    this.blockedUntil = this.now() + delay;
    this.schedule(delay);
  }

  private pump(): void {
    if (this.stopped || this.inFlight || !this.queue.length) return;
    const wait = this.blockedUntil - this.now();
    if (wait > 0) {
      this.schedule(wait);
      return;
    }
    const head = this.queue[0];
    this.inFlight = true;
    let req: Promise<{ status: number; headers?: { get(name: string): string | null } }>;
    try {
      req = this.request(head.body, false);
    } catch (err) {
      req = Promise.reject(err);
    }
    req
      .then(
        (res) => {
          const status = res?.status ?? 0;
          if (status === 429 || status === 503) {
            this.backoff(retryAfter(res.headers?.get('Retry-After'), this.now()));
          } else if (status >= 500 || status === 0) {
            this.backoff(null);
          } else if (status === 401 || status === 403 || status === 404 || status === 410) {
            this.stop();
            this.opts.onFatal?.(status);
          } else {
            // 2xx delivered (409 = already stored); other 4xx (400/413) are permanent for this chunk.
            this.shiftHead(head);
            if (status >= 400 && status !== 409) {
              if (!head.delivered) this.dropped++;
            } else this.delivered(head);
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

  private shiftHead(head: { body: Uint8Array }): void {
    if (this.queue[0] === head) {
      this.queue.shift();
      this.queuedBytes -= head.body.length;
    }
  }
}

// ---------------------------------------------------------------- controller

export interface ReplayDefaults {
  appName?: string;
  environment?: string;
  appVersion?: string;
  /** PlatformConfig.apiBase: fallback replay endpoint `<apiBase>/api/sdk/replay`. */
  apiBase?: string;
  /** PlatformConfig.token: used when the telemetry block has no browser token. */
  token?: string;
  respectDoNotTrack?: boolean;
}

interface Context {
  endpoint: string;
  token: string;
  subjectId: string;
  options: PlatformReplayOptions;
  defaults: ReplayDefaults;
  env: Required<Pick<ReplayEnvironment, 'random' | 'now'>> & ReplayEnvironment;
  load: () => Promise<ReplayRecorderModule>;
}

let ctx: Context | null = null;
let active: ReplayHandle | null = null;
let starting: Promise<ReplayHandle | null> | null = null;
let consentWaiter: (() => void) | null = null;

function browserReplayEnv(): ReplayEnvironment {
  const win: any = typeof window !== 'undefined' ? window : undefined;
  const pick = (name: 'sessionStorage' | 'localStorage') => {
    try {
      return win ? (win[name] as Storage) : null;
    } catch {
      return null;
    }
  };
  return { win, nav: typeof navigator !== 'undefined' ? navigator : undefined, session: pick('sessionStorage'), local: pick('localStorage') };
}

/** Replay API base for a configuration, or null when there is nowhere to send data. */
export function replayEndpoint(options: PlatformReplayOptions, telemetry: PlatformTelemetryConfig | null | undefined, defaults: ReplayDefaults): string | null {
  const raw = options.endpoint || telemetry?.replayEndpoint || (defaults.apiBase ? `${defaults.apiBase.replace(/\/+$/, '')}/api/sdk/replay` : '');
  if (!raw) return null;
  try {
    const u = new URL(raw, typeof location !== 'undefined' ? location.href : undefined);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Path of the current page (no origin, query or fragment), redacted. */
function currentPath(win: any): string {
  try {
    return sanitizeUrl(String(win?.location?.href || '/')).replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0] || '/';
  } catch {
    return '/';
  }
}

async function askServer(c: Context, sessionId: string): Promise<boolean> {
  if (!c.env.fetchImpl) return false;
  const url = `${c.endpoint}/allowed?subjectId=${encodeURIComponent(c.subjectId)}&sessionId=${encodeURIComponent(sessionId)}`;
  const res = await c.env.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${c.token}` }, credentials: 'omit' });
  if (!res || res.status !== 200 || !res.json) return false;
  const body = await res.json();
  return !!(body && body.replayAllowed === true);
}

/**
 * Start session replay for this page when configured, sampled in and consented.
 * Resolves to null otherwise (rrweb is then never downloaded). Never throws.
 */
export function startReplay(
  options: PlatformReplayOptions | false | null | undefined,
  telemetry: PlatformTelemetryConfig | null | undefined,
  defaults: ReplayDefaults = {},
  deps: { env?: ReplayEnvironment; load?: () => Promise<ReplayRecorderModule>; onSkip?: (reason: ReplaySkipReason) => void } = {},
): Promise<ReplayHandle | null> {
  if (starting) return starting;
  const skip = (reason: ReplaySkipReason) => {
    deps.onSkip?.(reason);
    return null;
  };
  starting = (async () => {
    try {
      if (!options) return skip('not-configured');
      const base = deps.env ?? browserReplayEnv();
      const env = {
        ...base,
        random: base.random ?? Math.random,
        now: base.now ?? (() => Date.now()),
        fetchImpl: base.fetchImpl ?? (base.win && typeof base.win.fetch === 'function' ? base.win.fetch.bind(base.win) : undefined),
      };
      if (!env.win || !env.win.document) return skip('no-browser');
      if (telemetry && telemetry.enabled === false && !options.endpoint && !defaults.apiBase) return skip('disabled');
      const endpoint = replayEndpoint(options, telemetry, defaults);
      const token = (telemetry && telemetry.browserToken) || defaults.token || '';
      if (!endpoint || !token) return skip('no-endpoint');
      if (defaults.respectDoNotTrack !== false && isDoNotTrack(env.nav, env.win)) return skip('do-not-track');
      const c: Context = {
        endpoint,
        token,
        subjectId: subjectIdFor(options, env.local, env.random),
        options,
        defaults,
        env,
        load: deps.load ?? (() => import('./rum-replay-record') as Promise<ReplayRecorderModule>),
      };
      ctx = c;
      const session = loadReplaySession(options, env.session, env.now(), env.random);
      if (session.mode === 'off') return skip('not-sampled');
      const allowed = await resolveReplayConsent({
        requireConsent: options.requireConsent !== false,
        local: readLocalConsent(env.local),
        askServer: () => askServer(c, session.id),
      });
      if (!allowed) {
        // setConsent({ replay: true }) later starts recording without a reload.
        consentWaiter = () => {
          consentWaiter = null;
          starting = null;
          void startReplay(options, telemetry, defaults, deps);
        };
        return skip('no-consent');
      }
      const mod = await c.load();
      active = record(c, mod, session);
      return active;
    } catch {
      return null; // replay must never break the host app
    }
  })();
  return starting;
}

function record(c: Context, mod: ReplayRecorderModule, session: ReplaySessionState): ReplayHandle {
  const { env, options } = c;
  const win = env.win;
  let mode = session.mode as ReplayMode;
  let stopped = false;
  const cleanups: Array<() => void> = [];
  const uploader = new ReplayUploader({
    url: `${c.endpoint}/chunks`,
    token: c.token,
    compress: mod.gzip,
    fetchImpl: env.fetchImpl,
    now: env.now,
    random: env.random,
    setTimer: env.setTimer,
    onFatal: () => handle.stop(),
  });
  let page = currentPath(win);
  let hiding = false;
  const meta = (): Omit<EnvelopeMeta, 'seq'> => ({
    sessionId: session.id,
    mode,
    page,
    subjectId: c.subjectId,
    userId: options.userId && /^[A-Za-z0-9_.:-]{1,128}$/.test(options.userId) ? options.userId : undefined,
    environment: c.defaults.environment,
    release: c.defaults.appVersion,
    app: c.defaults.appName,
    viewport: { w: Number(win.innerWidth) || 0, h: Number(win.innerHeight) || 0 },
  });
  const chunker = new ReplayChunker(
    (chunk) => {
      const seq = session.seq++;
      session.lastActivity = env.now();
      saveReplaySession(env.session, session);
      uploader.enqueue(seq, buildEnvelope({ ...meta(), seq }, chunk), { pump: !hiding });
    },
    { maxBytes: options.maxChunkBytes, flushIntervalMs: options.flushIntervalMs, setTimer: env.setTimer, clearTimer: env.clearTimer },
  );
  chunker.note('page', page);
  const buffer = new ReplayBuffer();

  const emit = (event: any, isCheckout?: boolean) => {
    if (stopped || !event) return;
    try {
      if (event.type === 4 && event.data && typeof event.data.href === 'string') {
        event.data.href = sanitizeUrl(event.data.href); // Meta: no query values / credentials
      }
      const ts = Number(event.timestamp) || env.now();
      const s = JSON.stringify(event);
      if (mode === 'buffer') buffer.add(s, ts, !!isCheckout);
      else chunker.add(s, ts);
    } catch {
      /* unserializable event: skip */
    }
  };

  const recorder = mod.startRecorder(buildRecordOptions(options, mode), emit);
  const custom = (tag: string, payload: Record<string, unknown>) => {
    try {
      recorder.addCustomEvent(tag, payload);
    } catch {
      /* ignore */
    }
  };

  const promote = () => {
    if (mode !== 'buffer') return;
    mode = 'session';
    session.mode = 'session';
    saveReplaySession(env.session, session);
    for (const [s, ts] of buffer.drain()) chunker.add(s, ts);
  };

  const onError = (message: string, type: string, source: string) => {
    if (stopped) return;
    custom('error', { message: scrubText(message).slice(0, 300), type: type.slice(0, 100), source });
    chunker.note('error');
    promote();
    chunker.flush();
  };

  // Errors: uncaught (window) + framework-caught (reportRumError hook).
  const onWindowError = (ev: any) => onError(String(ev?.message || ev?.error?.message || 'Error'), String(ev?.error?.name || 'Error'), 'window');
  const onRejection = (ev: any) => {
    const r = ev?.reason;
    onError(String(r?.message || r || 'Unhandled rejection'), String(r?.name || 'UnhandledRejection'), 'unhandledrejection');
  };
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('error', onWindowError);
    win.addEventListener('unhandledrejection', onRejection);
    cleanups.push(() => {
      win.removeEventListener('error', onWindowError);
      win.removeEventListener('unhandledrejection', onRejection);
    });
  }

  // Network markers: client spans from RUM (with trace ids), else resource timings.
  const endpointPrefix = c.endpoint;
  const network = (method: string, url: string, status: number | undefined, durationMs: number, traceId?: string) => {
    if (options.captureNetwork === false || url.startsWith(endpointPrefix)) return;
    const failed = status === 0 || (typeof status === 'number' && status >= 500);
    custom('network', { method, url: sanitizeUrl(url), status: status ?? null, durationMs: Math.round(durationMs), traceId: traceId || null, failed });
    if (failed) chunker.note('networkError');
    if (traceId) chunker.note('trace', traceId);
  };
  cleanups.push(
    addRumHook({
      onError: (error: unknown) => {
        const e: any = error;
        onError(String(e?.message || e || 'Error'), String(e?.name || 'Error'), 'framework');
      },
      onSpan: (span) => {
        let url = span.url;
        try {
          url = new URL(span.url, win.location?.href).href;
        } catch {
          /* keep */
        }
        network(span.method, url, span.error ? 0 : span.status, span.endMs - span.startMs, span.traceId);
      },
    }),
  );
  const PO = win.PerformanceObserver;
  if (options.captureNetwork !== false && typeof PO === 'function') {
    try {
      const po = new PO((list: any) => {
        if (getRum()) return; // RUM client spans already report these, with trace ids
        for (const e of list.getEntries()) {
          if (e.initiatorType !== 'fetch' && e.initiatorType !== 'xmlhttprequest') continue;
          network(e.initiatorType === 'fetch' ? 'FETCH' : 'XHR', String(e.name), typeof e.responseStatus === 'number' && e.responseStatus > 0 ? e.responseStatus : undefined, Number(e.duration) || 0);
        }
      });
      po.observe({ type: 'resource', buffered: false });
      cleanups.push(() => po.disconnect());
    } catch {
      /* unsupported */
    }
  }

  // SPA navigation: marker + fresh snapshot of the new page (heatmap backgrounds, seeking).
  const navTimer = (env.setTimer ? null : setInterval(() => checkNav(), 1000)) as any;
  let snapTimer: any = null;
  const checkNav = () => {
    const next = currentPath(win);
    if (next === page || stopped) return;
    page = next;
    custom('navigation', { path: page, route: normalizeRouteName(page) });
    chunker.note('page', page);
    if (options.snapshotOnNavigation !== false) {
      if (snapTimer) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        try {
          if (!stopped) recorder.takeFullSnapshot(false);
        } catch {
          /* ignore */
        }
      }, 300);
    }
  };
  if (navTimer) cleanups.push(() => clearInterval(navTimer));
  cleanups.push(() => snapTimer && clearTimeout(snapTimer));
  // Detect SPA navigations immediately (history API + back/forward); the 1 s poll
  // above stays as a fallback. Fast clicks (under a second apart) were missed.
  const hist = (win as any)?.history;
  if (hist && typeof hist.pushState === 'function') {
    const wrap = (name: 'pushState' | 'replaceState') => {
      const original = hist[name];
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const result = original.apply(this, args);
        try { checkNav(); } catch { /* ignore */ }
        return result;
      };
      hist[name] = wrapped;
      cleanups.push(() => { if (hist[name] === wrapped) hist[name] = original; });
    };
    wrap('pushState');
    wrap('replaceState');
  }
  if (win && typeof (win as any).addEventListener === 'function') {
    const onPop = () => { try { checkNav(); } catch { /* ignore */ } };
    (win as any).addEventListener('popstate', onPop);
    cleanups.push(() => (win as any).removeEventListener('popstate', onPop));
  }

  // Unload (pagehide, or visibilitychange -> hidden, whichever fires first): flush the
  // open chunk in keepalive-sized pieces without starting normal fetches, then send
  // everything queued with keepalive. A normal fetch started here would often be
  // cancelled by the unload, losing the last page (or a whole short session).
  const onHide = () => {
    if (stopped) return;
    if (mode === 'session') {
      hiding = true;
      try {
        chunker.flush(UNLOAD_PIECE_BYTES);
      } finally {
        hiding = false;
      }
      uploader.flushUnload();
    }
  };
  const onVisibility = () => {
    if (win.document?.visibilityState === 'hidden') onHide();
  };
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('pagehide', onHide);
    win.document?.addEventListener?.('visibilitychange', onVisibility);
    cleanups.push(() => {
      win.removeEventListener('pagehide', onHide);
      win.document?.removeEventListener?.('visibilitychange', onVisibility);
    });
  }

  setReplayIdForErrors(session.id);
  const handle: ReplayHandle = {
    sessionId: session.id,
    get mode() {
      return mode;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
      cleanups.splice(0).forEach((fn) => {
        try {
          fn();
        } catch {
          /* ignore */
        }
      });
      uploader.stop();
      setReplayIdForErrors(undefined);
      if (active === handle) active = null;
    },
  } as ReplayHandle;
  // Exposed for tests: drive navigation checks without timers.
  (handle as any)._checkNav = checkNav;
  (handle as any)._flush = () => chunker.flush();
  (handle as any)._uploader = uploader;
  return handle;
}

/** The running replay, if any. */
export function getReplay(): ReplayHandle | null {
  return active;
}

/** Stop recording (logout, consent withdrawn, tests). Already uploaded chunks stay on the server. */
export function stopReplay(): void {
  try {
    active?.stop();
  } finally {
    active = null;
    starting = null;
    consentWaiter = null;
  }
}

/**
 * Record the user's consent decision (`platform.setConsent({ replay: true })`).
 * Stored on this device; sent to the platform when replay is configured; `false`
 * stops a running recording immediately, `true` starts a pending one.
 */
export function setConsent(consent: { replay?: boolean }): void {
  if (!consent || typeof consent.replay !== 'boolean') return;
  const env = ctx?.env ?? browserReplayEnv();
  try {
    env.local?.setItem(CONSENT_KEY, consent.replay ? '1' : '0');
  } catch {
    /* blocked: decision applies to this page only */
  }
  if (!consent.replay) stopReplay();
  const c = ctx;
  if (c && c.env.fetchImpl) {
    const sessionId = active?.sessionId ?? '';
    void c.env
      .fetchImpl(`${c.endpoint}/consent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
        body: JSON.stringify({ subjectId: c.subjectId, sessionId, replayAllowed: consent.replay }),
        credentials: 'omit',
        keepalive: true,
      })
      .catch(() => {});
  }
  if (consent.replay && consentWaiter) consentWaiter();
}
