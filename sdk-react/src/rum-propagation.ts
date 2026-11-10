/**
 * Minimal W3C trace-context propagation for fetch and XMLHttpRequest (which also
 * covers Angular HttpClient and axios). For every request whose URL passes
 * `allow`, a client span id is generated, a `traceparent` header is added and the
 * finished request is reported through `onSpan` (exported to Tempo via Faro).
 * Requests to other origins are left untouched: no header, no span.
 *
 * Hand-rolled instead of @grafana/faro-web-tracing (OpenTelemetry web, ~55 KB gzip)
 * to stay inside the SDK bundle budget.
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */

export interface ClientSpan {
  traceId: string;
  spanId: string;
  method: string;
  url: string;
  startMs: number;
  endMs: number;
  status: number;
  error: boolean;
}

export interface PropagationOptions {
  allow: (url: string) => boolean;
  onSpan: (span: ClientSpan) => void;
  /** Wall-clock milliseconds (default `Date.now`). */
  now?: () => number;
  /** Source of random bytes (default `crypto.getRandomValues`, falls back to Math.random). */
  randomBytes?: (n: number) => Uint8Array;
  /** Global object to patch (default `window`). */
  win?: any;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c: any = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function hexId(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  // All-zero ids are invalid in W3C trace context.
  return /^0+$/.test(s) ? s.slice(0, -1) + '1' : s;
}

export function traceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

function requestUrl(input: any): string {
  if (typeof input === 'string') return input;
  if (input && typeof input.href === 'string') return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

const XHR_STATE = '__platformRum';

/** Patch fetch/XHR; returns a function that restores the originals. */
export function installPropagation(opts: PropagationOptions): () => void {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return () => {};
  const now = opts.now ?? (() => Date.now());
  const rnd = opts.randomBytes ?? defaultRandomBytes;
  const restores: Array<() => void> = [];

  const report = (span: ClientSpan) => {
    try {
      opts.onSpan(span);
    } catch {
      /* never break the request */
    }
  };

  const origFetch = win.fetch;
  if (typeof origFetch === 'function') {
    const patched = function (this: any, input: any, init?: any) {
      let url = '';
      try {
        url = requestUrl(input);
      } catch {
        /* ignore */
      }
      if (!url || !opts.allow(url) || typeof win.Headers !== 'function') {
        return origFetch.call(this ?? win, input, init);
      }
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const headers = new win.Headers(init?.headers ?? (typeof input === 'object' ? input?.headers : undefined));
      if (headers.has('traceparent')) return origFetch.call(this ?? win, input, init);
      const traceId = hexId(rnd(16));
      const spanId = hexId(rnd(8));
      headers.set('traceparent', traceparentHeader(traceId, spanId));
      const startMs = now();
      const done = (status: number, error: boolean) =>
        report({ traceId, spanId, method, url, startMs, endMs: now(), status, error });
      return origFetch.call(this ?? win, input, { ...(init || {}), headers }).then(
        (res: any) => {
          done(res?.status ?? 0, false);
          return res;
        },
        (err: unknown) => {
          done(0, true);
          throw err;
        },
      );
    };
    win.fetch = patched;
    restores.push(() => {
      if (win.fetch === patched) win.fetch = origFetch;
    });
  }

  const XHR = win.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const proto = XHR.prototype;
    const origOpen = proto.open;
    const origSetHeader = proto.setRequestHeader;
    const origSend = proto.send;
    proto.open = function (this: any, method: string, url: any, ...rest: any[]) {
      this[XHR_STATE] = { method: String(method || 'GET').toUpperCase(), url: requestUrl(url), hasTp: false };
      return origOpen.call(this, method, url, ...rest);
    };
    proto.setRequestHeader = function (this: any, name: string, value: string) {
      if (this[XHR_STATE] && String(name).toLowerCase() === 'traceparent') this[XHR_STATE].hasTp = true;
      return origSetHeader.call(this, name, value);
    };
    proto.send = function (this: any, body?: any) {
      const st = this[XHR_STATE];
      try {
        if (st && !st.hasTp && opts.allow(st.url)) {
          const traceId = hexId(rnd(16));
          const spanId = hexId(rnd(8));
          origSetHeader.call(this, 'traceparent', traceparentHeader(traceId, spanId));
          const startMs = now();
          const xhr = this;
          const onEnd = () => {
            xhr.removeEventListener?.('loadend', onEnd);
            const status = Number(xhr.status) || 0;
            report({ traceId, spanId, method: st.method, url: st.url, startMs, endMs: now(), status, error: status === 0 });
          };
          this.addEventListener?.('loadend', onEnd);
        }
      } catch {
        /* never break the request */
      }
      return origSend.call(this, body);
    };
    restores.push(() => {
      proto.open = origOpen;
      proto.setRequestHeader = origSetHeader;
      proto.send = origSend;
    });
  }

  return () => restores.forEach((r) => r());
}
