import { encryptValue, decryptValue } from './secrets-encryption';

function key(): string {
  const value = process.env.SECRETS_ENCRYPTION_KEY;
  if (!value) throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  return value;
}
/** Read legacy plaintext rows, but always encrypt on the next save. */
export const storageCredentialsTransformer = {
  to(value: Record<string, string> | null): Record<string, string> | null {
    return value ? { __encrypted: encryptValue(JSON.stringify(value), key()) } : null;
  },
  from(value: Record<string, string> | null): Record<string, string> | null {
    return value?.__encrypted ? JSON.parse(decryptValue(value.__encrypted, key())) : value;
  },
};
export function publicStorageProvider<T extends { credentials: unknown }>(provider: T): Omit<T, 'credentials'> {
  const { credentials, ...safe } = provider;
  return safe;
}
