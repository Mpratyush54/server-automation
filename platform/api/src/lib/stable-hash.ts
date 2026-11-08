import crypto from 'crypto';

/** JSON.stringify with object keys sorted recursively (stable across key order). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function stableHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/** Key for encrypting coordination data at rest (operation state, replayed responses). */
export function coordinationEncryptionKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SECRETS_ENCRYPTION_KEY || env.JWT_SECRET || null;
}
