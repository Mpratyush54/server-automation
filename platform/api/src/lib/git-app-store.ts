/**
 * Storage for automatically created Git provider credentials (#35).
 *
 * Secrets are encrypted with the same helper and key order as project secrets
 * (SECRETS_ENCRYPTION_KEY, falling back to JWT_SECRET on installs that never set it) and
 * are decrypted only in memory when a request needs them. Nothing here returns a secret to
 * an HTTP caller: {@link publicAppView} is the only shape routes may serialize.
 */
import { getDb } from '../config/database';
import { GitProviderApp, GitAppProvider } from '../entities/GitProviderApp';
import { encryptValue, decryptValue } from './secrets-encryption';

// Same key order as project secrets (lib/project-db-ensure.ts secretWriteKey/decryptStoredSecret),
// kept local so this module does not load the database-service pg pool.
function encryptionKeys(): string[] {
  return Array.from(new Set([process.env.SECRETS_ENCRYPTION_KEY, process.env.JWT_SECRET].filter((k): k is string => !!k)));
}

export function encryptAppSecret(value: string): string {
  const key = encryptionKeys()[0];
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is not configured');
  return encryptValue(value, key);
}

export function decryptAppSecret(payload: string | null | undefined): string {
  if (!payload) return '';
  let lastErr: unknown = new Error('SECRETS_ENCRYPTION_KEY is not configured');
  for (const key of encryptionKeys()) {
    try {
      return decryptValue(payload, key);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function appRepo() {
  const ds = await getDb();
  return ds.getRepository(GitProviderApp);
}

/** The stored row for `provider`, or null (also when the table is unreachable). */
export async function loadProviderApp(provider: GitAppProvider): Promise<GitProviderApp | null> {
  try {
    const repo = await appRepo();
    const row = await repo.findOne({ where: { provider } });
    return row && row.provider === provider ? row : null;
  } catch {
    return null;
  }
}

/** Insert or replace the row for `provider` (reconnect replaces the previous credentials). */
export async function saveProviderApp(provider: GitAppProvider, fields: Partial<GitProviderApp>): Promise<GitProviderApp> {
  const repo = await appRepo();
  const existing = await repo.findOne({ where: { provider } });
  const blank: Partial<GitProviderApp> = {
    appId: null, slug: null, owner: null, ownerType: null, baseUrl: null, htmlUrl: null,
    clientId: null, clientSecretEnc: null, webhookSecretEnc: null, privateKeyEnc: null,
    apiTokenEnc: null, lastCheckedAt: null, lastCheckOk: null, lastError: null,
  };
  const row = existing
    ? Object.assign(existing, blank, fields, { provider })
    : repo.create({ ...blank, ...fields, provider } as GitProviderApp);
  return (await repo.save(row)) as GitProviderApp;
}

export async function deleteProviderApp(provider: GitAppProvider): Promise<boolean> {
  const repo = await appRepo();
  const res = await repo.delete({ provider });
  return Boolean(res?.affected);
}

export async function recordHealth(provider: GitAppProvider, ok: boolean, error: string | null): Promise<void> {
  try {
    const repo = await appRepo();
    await repo.update({ provider }, { lastCheckedAt: new Date(), lastCheckOk: ok, lastError: error ? error.slice(0, 500) : null });
  } catch {
    /* health bookkeeping is best effort */
  }
}

/** Public, secret-free description of a stored app (the only shape routes return). */
export function publicAppView(row: GitProviderApp | null) {
  if (!row) return { connected: false as const };
  return {
    connected: true as const,
    provider: row.provider,
    appId: row.appId,
    slug: row.slug,
    owner: row.owner,
    ownerType: row.ownerType,
    baseUrl: row.baseUrl,
    htmlUrl: row.htmlUrl,
    clientId: row.clientId,
    hasClientSecret: Boolean(row.clientSecretEnc),
    hasWebhookSecret: Boolean(row.webhookSecretEnc),
    hasPrivateKey: Boolean(row.privateKeyEnc),
    hasApiToken: Boolean(row.apiTokenEnc),
    installUrl: row.provider === 'github' && row.slug ? githubInstallUrl(row.slug) : null,
    health: {
      checkedAt: row.lastCheckedAt,
      ok: row.lastCheckOk,
      error: row.lastError,
    },
    connectedAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function githubInstallUrl(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
