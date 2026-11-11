import { createHash } from 'crypto';
import { ErrorEvent, ErrorFrame } from './error-event';

/** Strip URL credentials/query/hash; preserve full path to avoid bundle collisions. */
export function errorFile(file: string): string {
  try { return new URL(file).pathname; } catch { return file.split(/[?#]/)[0].replace(/\\/g, '/'); }
}
/** Legacy (v1) fingerprint. Still computed so issues created before #156 keep
 * receiving events through their stored aliases. */
export function fingerprint(event: ErrorEvent): string {
  // Coordinates identify the callsite. Function names may still be minified when
  // a source map omits its names table, so they must not split release groups.
  const frames = event.frames.slice(0, 5).map(f => [errorFile(f.file), f.line, f.column]);
  const fallback = event.message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/\b\d+\b/g, '#');
  return createHash('sha256').update(JSON.stringify([event.type, frames.length ? frames : fallback])).digest('hex');
}

/** Version tag of the engine-neutral grouping fingerprint (#156). Bump when the
 * normalisation changes; older versions stay valid as issue aliases. */
export const GROUPING_VERSION = 'v2';

const INTERNAL_FILES = new Set(['', '?', '<anonymous>', 'anonymous', '<unknown>', 'native', '[native code]', 'eval', '<eval>']);
const INTERNAL_PREFIX = /^(chrome|moz|safari|safari-web|ms-browser)-extension:|^webkit-masked-url:|^node:|^internal\//i;
// Our own SDKs and the Faro instrumentation they wrap: never the cause of an app error.
const SDK_PATH = /\/@mpratyush54\/sdk-|\/@grafana\/faro-|\/faro-web-sdk|\/sdk-(react|angular|node)\/(dist|src)\//i;
const VENDOR_PATH = /\/node_modules\/|\/webpack\/bootstrap|(^|\/)(vendors?|framework|polyfills|runtime|react-dom|zone)([.~_-][^/]*)?\.m?js$/i;
const SDK_FUNCTIONS = /^(Error|captureException|pushError)$/;
const ANONYMOUS = new Set(['', '?', '<anonymous>', 'anonymous', 'Anonymous function', 'global code', 'eval code', 'module code', '<unknown>', '<eval>']);

/** Strip build content hashes so the same module keeps one identity across
 * deploys: main.3f2a1b9c.js, main.3f2a1b9c.chunk.js, chunk-ABCD1234.js,
 * index-B_xY3a9Z.js and hashed directories (Next.js build ids). */
export function bundlePath(file: string): string {
  const parts = errorFile(file).split('/');
  const last = parts.length - 1;
  return parts.map((seg, i) => {
    if (i < last) return /^[a-f0-9]{8,}$/i.test(seg) || (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg)) ? '<hash>' : seg;
    return seg
      .replace(/[.-][a-f0-9]{8,}(?=\.)/gi, '')
      .replace(/-([A-Za-z0-9_-]{8})(?=\.(?:m?js|css)$)/, (m, h: string) => (/[\dA-Z_-]/.test(h) ? '' : m));
  }).join('/');
}

/** Engine-neutral function name: V8 "Object.fn"/"async fn"/"new Foo"/"fn [as x]",
 * SpiderMonkey "outer/inner"/"fn/<", JavaScriptCore "global code". */
export function frameFunction(name?: string): string | undefined {
  let f = (name || '').trim().replace(/\s+\[as [^\]]*\]$/, '').replace(/^(async|new)\s+/, '').replace(/^\*/, '');
  if (/\/<+$|<$/.test(f)) return undefined; // SpiderMonkey anonymous closure
  f = f.split('/').pop()!.split('.').pop()!.trim();
  return ANONYMOUS.has(f) ? undefined : f;
}

function isInternal(f: ErrorFrame): boolean {
  const file = (f.file || '').trim();
  return INTERNAL_FILES.has(file) || INTERNAL_PREFIX.test(file) || SDK_PATH.test(file) || SDK_FUNCTIONS.test(frameFunction(f.function) || '');
}

/** Message normalisation for frameless errors: engine prefixes and volatile values. */
export function normalizeMessage(message: string): string {
  return message.replace(/^\s*Uncaught\s+/i, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\b\d+\b/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Engine- and build-neutral grouping key (#156). `raw` are the frames the SDK
 * sent; `mapped` is the symbolicated copy (same length/order). Frames from the
 * SDK, the browser and anonymous locations are dropped, in-app frames are
 * preferred over vendor/framework ones, and each frame contributes its
 * hash-stripped path plus function name. Lines only count for source-mapped
 * frames: generated line/column move between builds and engines.
 */
export function groupingFingerprint(raw: ErrorEvent, mapped: ErrorEvent = raw): string {
  const frames = raw.frames.map((r, i) => {
    const m = mapped.frames[i] || r;
    const isMapped = m !== r && (m.file !== r.file || m.line !== r.line || m.column !== r.column);
    return { frame: isMapped ? m : r, isMapped };
  }).filter(f => !isInternal(f.frame));
  const inApp = frames.filter(f => !VENDOR_PATH.test(errorFile(f.frame.file)));
  const keys: string[] = [];
  for (const { frame, isMapped } of inApp.length ? inApp : frames) {
    const key = JSON.stringify([bundlePath(frame.file), frameFunction(frame.function) || null, isMapped ? frame.line : null]);
    if (keys[keys.length - 1] !== key) keys.push(key); // engines repeat frames differently
    if (keys.length === 5) break;
  }
  const type = raw.type.replace(/^\s*Uncaught\s+/i, '').trim();
  const body = JSON.stringify([GROUPING_VERSION, type, keys.length ? keys : normalizeMessage(raw.message)]);
  return `${GROUPING_VERSION}:${createHash('sha256').update(body).digest('hex')}`;
}

const V8_FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^\s*(.*?)@(.*?):(\d+):(\d+)\s*$/;

/** Parse a browser `Error.stack` string. V8 ("at fn (url:line:col)", "at url:line:col")
 * and SpiderMonkey/JavaScriptCore ("fn@url:line:col", "@url:line:col") lines yield
 * the same frames; other lines (message, "[native code]") are skipped. Columns are
 * converted from the engines' one-based to the wire contract's zero-based. */
export function parseStack(stack: string): ErrorFrame[] {
  const frames: ErrorFrame[] = [];
  for (const line of stack.slice(0, 65536).split(/\r?\n/)) {
    const m = V8_FRAME.exec(line) || GECKO_FRAME.exec(line);
    if (!m) continue;
    const fn = m[1]?.trim();
    frames.push({ file: m[2], line: Math.max(1, Number(m[3])), column: Math.max(0, Number(m[4]) - 1), ...(fn ? { function: fn } : {}) });
    if (frames.length === 100) break;
  }
  return frames;
}

/** Semver ordering for numbered releases. Opaque git SHAs use first occurrence:
 * a previously unseen version after resolution is considered a new release. */
export function isNewerRelease(next: string, resolved: string, known: Record<string, number>): boolean {
  if (next === resolved) return false;
  const parse = (s: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s)?.slice(1).map(Number);
  const a = parse(next), b = parse(resolved);
  if (a && b) {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  return !Object.prototype.hasOwnProperty.call(known, next);
}
