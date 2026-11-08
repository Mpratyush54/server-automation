import * as crypto from 'crypto';

/**
 * In-memory store for short-lived, single-use codes (OIDC authorization codes,
 * SSO login exchange codes, OAuth login state). `consume` deletes before returning,
 * so a code can be redeemed at most once.
 */
export class OneTimeCodeStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 10_000) {}

  issue(value: T): string {
    this.purge();
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest entry rather than growing without bound.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const code = crypto.randomBytes(32).toString('base64url');
    this.entries.set(code, { value, expiresAt: Date.now() + this.ttlMs });
    return code;
  }

  consume(code: unknown): T | null {
    if (typeof code !== 'string' || !code) return null;
    const entry = this.entries.get(code);
    if (!entry) return null;
    this.entries.delete(code);
    if (entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private purge(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
