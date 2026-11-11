/**
 * SMTP credentials (password, API key) at rest: encrypted with SECRETS_ENCRYPTION_KEY, the
 * same AES-256-GCM helper as alert channel and storage provider secrets.
 *
 * Stored values carry an `enc:v1:` prefix. Rows written before encryption existed hold the
 * plain value; they are still readable (decrypt-if-encrypted) and are rewritten encrypted at
 * startup by {@link encryptLegacySmtpSecrets} and on any later save.
 */
import type { DataSource } from 'typeorm';
import { decryptValue, encryptValue } from './secrets-encryption';

export const SMTP_SECRET_PREFIX = 'enc:v1:';

function key(): string {
  const value = process.env.SECRETS_ENCRYPTION_KEY;
  if (!value) throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  return value;
}

export function isEncryptedSmtpSecret(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SMTP_SECRET_PREFIX);
}

export function encryptSmtpSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (isEncryptedSmtpSecret(value)) return value;
  return SMTP_SECRET_PREFIX + encryptValue(value, key());
}

export function decryptSmtpSecret(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!isEncryptedSmtpSecret(value)) return value; // legacy plaintext row
  try {
    return decryptValue(value.slice(SMTP_SECRET_PREFIX.length), key());
  } catch {
    console.warn('[smtp] stored SMTP credential cannot be decrypted (encryption key changed?)');
    return null;
  }
}

/** TypeORM column transformer: plaintext in memory, ciphertext in the database. */
export const smtpSecretTransformer = {
  to: (value: string | null | undefined): string | null => encryptSmtpSecret(value ?? null),
  from: (value: string | null): string | null => decryptSmtpSecret(value),
};

/** Re-save legacy plaintext SMTP credentials encrypted. Idempotent; no-op without a key. */
export async function encryptLegacySmtpSecrets(ds: Pick<DataSource, 'query'>): Promise<number> {
  if (!process.env.SECRETS_ENCRYPTION_KEY) return 0;
  const rows: { id: string; password: string | null; api_key: string | null }[] = await ds.query(
    `SELECT id, password, api_key FROM smtp_configs
      WHERE (password IS NOT NULL AND password NOT LIKE 'enc:v1:%')
         OR (api_key IS NOT NULL AND api_key NOT LIKE 'enc:v1:%')`,
  );
  for (const row of rows) {
    await ds.query(`UPDATE smtp_configs SET password = $1, api_key = $2 WHERE id = $3`, [
      encryptSmtpSecret(row.password),
      encryptSmtpSecret(row.api_key),
      row.id,
    ]);
  }
  return rows.length;
}

/** Shape returned by the API: secrets are never echoed, only whether they are set. */
export function publicSmtpConfig<T extends { password?: string | null; apiKey?: string | null }>(c: T) {
  const { password, apiKey, ...rest } = c;
  return { ...rest, password: password ? '***' : null, apiKey: apiKey ? '***' : null, hasPassword: !!password, hasApiKey: !!apiKey };
}
