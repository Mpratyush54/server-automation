import { createHash } from 'crypto';
import { ErrorEvent } from './error-event';

/** Strip URL credentials/query/hash; preserve full path to avoid bundle collisions. */
export function errorFile(file: string): string {
  try { return new URL(file).pathname; } catch { return file.split(/[?#]/)[0].replace(/\\/g, '/'); }
}
export function fingerprint(event: ErrorEvent): string {
  // Coordinates identify the callsite. Function names may still be minified when
  // a source map omits its names table, so they must not split release groups.
  const frames = event.frames.slice(0, 5).map(f => [errorFile(f.file), f.line, f.column]);
  const fallback = event.message.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>').replace(/\b\d+\b/g, '#');
  return createHash('sha256').update(JSON.stringify([event.type, frames.length ? frames : fallback])).digest('hex');
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
