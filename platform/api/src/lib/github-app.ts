/**
 * GitHub App via the App Manifest flow (#35). No relay server: GitHub hosts the creation UI,
 * this install converts the one-time code and keeps the App's credentials itself.
 *
 *  1. An admin asks for a manifest (POST /settings/integrations/github/manifest). We issue a
 *     single-use `state` bound to that admin (Redis, 15 min) and the portal auto-submits the
 *     manifest to github.com/settings/apps/new (or the org variant) with that state.
 *  2. GitHub redirects back to the portal with `code` + `state`; the portal posts both to
 *     .../manifest/complete with the admin's session. We consume the state (replay-safe),
 *     check it belongs to the same admin, then POST /app-manifests/{code}/conversions and
 *     store the App id/slug/client id+secret/webhook secret/private key, encrypted.
 *  3. The App signs RS256 JWTs (iss = app id) to mint installation access tokens, which are
 *     cached (Redis, encrypted) until shortly before they expire and used for repo access.
 *     Push / pull_request / installation events arrive on the App webhook, signed with the
 *     App's webhook secret, so linking a repository needs no personal token or repo hook.
 */
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getDb } from '../config/database';
import { GitAppInstallation } from '../entities/GitAppInstallation';
import { createCodeStore } from './oidc-codes';
import { redisKey, stateBackend, withRedis } from './redis';
import { parseGitRemote } from './git-remote';
import {
  decryptAppSecret, encryptAppSecret, githubInstallUrl, loadProviderApp, recordHealth, saveProviderApp,
} from './git-app-store';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
export const MANIFEST_STATE_TTL_MS = 15 * 60 * 1000;
/** Refresh an installation token this long before GitHub expires it (tokens live 1 h). */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const USER_AGENT = 'platform-api';

export class GithubAppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'GithubAppError';
  }
}

// ---------------------------------------------------------------------------
// Manifest + state
// ---------------------------------------------------------------------------

export type ManifestOwnerType = 'user' | 'org';

interface ManifestState {
  userId: string;
  ownerType: ManifestOwnerType;
  org: string | null;
  createdAt: number;
}

const manifestStates = createCodeStore<ManifestState>('gh-manifest-state', MANIFEST_STATE_TTL_MS);

/** Test hook: forget in-memory states. */
export function clearManifestStatesForTests(): void {
  manifestStates.clearMemory();
}

const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function defaultAppName(apiBase: string): string {
  let host = 'platform';
  try { host = new URL(apiBase).hostname; } catch { /* keep default */ }
  // App names are globally unique on GitHub and at most 34 characters; the admin can edit it on GitHub.
  const suffix = crypto.randomBytes(2).toString('hex');
  const base = `Platform ${host}`.slice(0, 34 - suffix.length - 1).trim();
  return `${base} ${suffix}`;
}

/**
 * The App manifest. Permissions are the minimum the platform uses: repository contents +
 * metadata (list repos, branches, commits, releases, clone), pull requests (PR previews) and
 * the user's email addresses (login with a verified email). Events push + pull_request drive
 * deploys and previews; `installation` / `installation_repositories` are delivered to every
 * App without subscribing (GitHub does not accept them in `default_events`).
 * The App-level webhook replaces per-repository hooks, so no administration/hooks permission.
 */
export function buildGithubManifest(opts: { apiBase: string; portalBase: string; name?: string }) {
  const apiBase = opts.apiBase.replace(/\/+$/, '');
  const portalBase = opts.portalBase.replace(/\/+$/, '');
  const name = (opts.name || '').trim().slice(0, 34) || defaultAppName(apiBase);
  return {
    name,
    url: portalBase,
    description: 'Self-hosted platform: sign-in, repository access and deploy webhooks.',
    hook_attributes: { url: `${apiBase}/api/webhooks/github`, active: true },
    redirect_url: `${portalBase}/settings`,
    callback_urls: [`${apiBase}/api/auth/github/callback`],
    setup_url: `${portalBase}/settings`,
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
      // Account permission; GitHub manifests call it "emails" ("email_addresses" is rejected).
      emails: 'read',
    },
    default_events: ['push', 'pull_request'],
  };
}

export async function startManifestFlow(opts: {
  userId: string;
  ownerType?: string;
  org?: string;
  name?: string;
  apiBase: string;
  portalBase: string;
}): Promise<{ manifest: ReturnType<typeof buildGithubManifest>; state: string; postUrl: string; expiresInSec: number }> {
  if (!opts.userId) throw new GithubAppError('Not authenticated', 401);
  const ownerType: ManifestOwnerType = opts.ownerType === 'org' ? 'org' : 'user';
  let org: string | null = null;
  if (ownerType === 'org') {
    org = String(opts.org || '').trim();
    if (!GITHUB_LOGIN_RE.test(org)) throw new GithubAppError('A valid GitHub organization login is required');
  }
  const manifest = buildGithubManifest({ apiBase: opts.apiBase, portalBase: opts.portalBase, name: opts.name });
  const state = await manifestStates.issue({ userId: opts.userId, ownerType, org, createdAt: Date.now() });
  const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new';
  return {
    manifest,
    state,
    postUrl: `${GITHUB_WEB}${path}?state=${encodeURIComponent(state)}`,
    expiresInSec: Math.floor(MANIFEST_STATE_TTL_MS / 1000),
  };
}

/**
 * Redeem a manifest `state`. Single use (consumed even when the caller is the wrong user, so a
 * leaked state cannot be retried), expires after MANIFEST_STATE_TTL_MS, and must belong to the
 * admin who started the flow.
 */
export async function verifyManifestState(state: unknown, userId: string): Promise<ManifestState> {
  const entry = await manifestStates.consume(state);
  if (!entry) throw new GithubAppError('Unknown, expired or already used state. Start the GitHub connection again.', 400);
  if (Date.now() - entry.createdAt > MANIFEST_STATE_TTL_MS) {
    throw new GithubAppError('Unknown, expired or already used state. Start the GitHub connection again.', 400);
  }
  if (!userId || entry.userId !== userId) {
    throw new GithubAppError('This GitHub connection was started by a different user.', 403);
  }
  return entry;
}

interface ConversionResult {
  id: number | string;
  slug: string;
  name?: string;
  html_url?: string;
  owner?: { login?: string; type?: string } | null;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

export async function completeManifestFlow(opts: { code: unknown; state: unknown; userId: string }) {
  await verifyManifestState(opts.state, opts.userId);
  const code = typeof opts.code === 'string' ? opts.code.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new GithubAppError('Missing or malformed code from GitHub');

  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    redirect: 'error',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GithubAppError(`GitHub rejected the manifest code (${res.status}): ${body.slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as ConversionResult;
  if (!data || !data.id || !data.slug || !data.client_id || !data.client_secret || !data.pem
    || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(data.pem)) {
    throw new GithubAppError('GitHub returned an incomplete App conversion', 502);
  }
  const webhookSecret = data.webhook_secret || '';
  const row = await saveProviderApp('github', {
    appId: String(data.id),
    slug: String(data.slug),
    owner: data.owner?.login || null,
    ownerType: data.owner?.type || null,
    htmlUrl: data.html_url || `${GITHUB_WEB}/apps/${data.slug}`,
    clientId: String(data.client_id),
    clientSecretEnc: encryptAppSecret(String(data.client_secret)),
    webhookSecretEnc: webhookSecret ? encryptAppSecret(webhookSecret) : null,
    privateKeyEnc: encryptAppSecret(String(data.pem)),
    createdBy: opts.userId,
  });
  await clearInstallationTokenCache();
  return { row, installUrl: githubInstallUrl(String(data.slug)) };
}

// ---------------------------------------------------------------------------
// Stored App credentials
// ---------------------------------------------------------------------------

export interface GithubAppCredentials {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKey: string;
}

/** Decrypted App credentials, or null when no App is connected (or the key cannot decrypt it). */
export async function loadGithubApp(): Promise<GithubAppCredentials | null> {
  const row = await loadProviderApp('github');
  if (!row || !row.appId || !row.privateKeyEnc) return null;
  try {
    return {
      appId: row.appId,
      slug: row.slug || '',
      clientId: row.clientId || '',
      clientSecret: decryptAppSecret(row.clientSecretEnc),
      webhookSecret: decryptAppSecret(row.webhookSecretEnc),
      privateKey: decryptAppSecret(row.privateKeyEnc),
    };
  } catch {
    return null;
  }
}

/** RS256 App JWT: iat backdated 60 s for clock drift, exp 9 min (GitHub allows at most 10). */
export function signAppJwt(appId: string, privateKey: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return jwt.sign({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: String(appId) }, privateKey, { algorithm: 'RS256' });
}

function appHeaders(token: string, scheme: 'Bearer' | 'token' = 'Bearer'): Record<string, string> {
  return {
    Authorization: `${scheme} ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ---------------------------------------------------------------------------
// Installation access tokens (cached)
// ---------------------------------------------------------------------------

interface CachedToken { token: string; expiresAt: number }

// Memory backend only under tests / PLATFORM_STATE_STORE=memory; deployments use Redis.
const memoryTokens = new Map<string, CachedToken>();

function tokenCacheKey(appId: string, installationId: string): string {
  return `gh-inst-token:${appId}:${installationId}`;
}

async function readCachedToken(key: string): Promise<CachedToken | null> {
  let entry: CachedToken | null = null;
  if (stateBackend() === 'redis') {
    try {
      const raw = await withRedis((r) => r.get(redisKey(key)));
      if (raw) entry = JSON.parse(decryptAppSecret(raw)) as CachedToken;
    } catch {
      entry = null; // cache miss on any Redis/decrypt problem: mint a fresh token
    }
  } else {
    entry = memoryTokens.get(key) || null;
  }
  if (!entry || entry.expiresAt - TOKEN_REFRESH_MARGIN_MS <= Date.now()) return null;
  return entry;
}

async function writeCachedToken(key: string, entry: CachedToken): Promise<void> {
  const ttl = entry.expiresAt - TOKEN_REFRESH_MARGIN_MS - Date.now();
  if (ttl <= 0) return;
  if (stateBackend() === 'redis') {
    try {
      await withRedis((r) => r.set(redisKey(key), encryptAppSecret(JSON.stringify(entry)), 'PX', ttl));
    } catch {
      /* not cached: the next call mints another token */
    }
  } else {
    memoryTokens.set(key, entry);
  }
}

export async function clearInstallationTokenCache(): Promise<void> {
  memoryTokens.clear();
  // Redis entries are keyed by app id, so a replaced App never reads the old App's tokens.
}

/** Installation access token for `installationId`, minted with the App JWT and cached. */
export async function getInstallationToken(installationId: string, app?: GithubAppCredentials | null): Promise<string> {
  const creds = app ?? (await loadGithubApp());
  if (!creds) throw new GithubAppError('GitHub App is not connected', 409);
  if (!/^\d{1,20}$/.test(String(installationId))) throw new GithubAppError('Invalid installation id');
  const key = tokenCacheKey(creds.appId, String(installationId));
  const cached = await readCachedToken(key);
  if (cached) return cached.token;

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    redirect: 'error',
    headers: appHeaders(signAppJwt(creds.appId, creds.privateKey)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GithubAppError(`GitHub installation token request failed (${res.status}): ${body.slice(0, 200)}`, 502);
  }
  const data: any = await res.json();
  if (!data?.token) throw new GithubAppError('GitHub returned no installation token', 502);
  const expiresAt = Date.parse(data.expires_at) || Date.now() + 60 * 60 * 1000;
  await writeCachedToken(key, { token: String(data.token), expiresAt });
  return String(data.token);
}

// ---------------------------------------------------------------------------
// Installations <-> repositories <-> projects
// ---------------------------------------------------------------------------

async function installationRepo() {
  const ds = await getDb();
  return ds.getRepository(GitAppInstallation);
}

export function installationCoversRepo(inst: Pick<GitAppInstallation, 'accountLogin' | 'repositorySelection' | 'repositories' | 'suspendedAt'>, owner: string, repo: string): boolean {
  if (inst.suspendedAt) return false;
  if (String(inst.accountLogin || '').toLowerCase() !== owner.toLowerCase()) return false;
  if (inst.repositorySelection === 'all') return true;
  const full = `${owner}/${repo}`.toLowerCase();
  return (inst.repositories || []).includes(full);
}

export async function listInstallations(): Promise<GitAppInstallation[]> {
  try {
    const repo = await installationRepo();
    return await repo.find({ order: { createdAt: 'ASC' } } as any);
  } catch {
    return [];
  }
}

export async function findInstallationForRepo(owner: string, repo: string): Promise<GitAppInstallation | null> {
  const all = await listInstallations();
  return all.find((i) => installationCoversRepo(i, owner, repo)) || null;
}

/**
 * Authorization header for GitHub API calls about `owner/repo`: an installation token when
 * the App is connected and installed on the repository, else the legacy GITHUB_TOKEN, else null.
 */
export async function githubAuthorizationFor(owner: string, repo: string): Promise<string | null> {
  try {
    const app = await loadGithubApp();
    if (app) {
      const inst = await findInstallationForRepo(owner, repo);
      if (inst) return `Bearer ${await getInstallationToken(inst.installationId, app)}`;
    }
  } catch (err: any) {
    console.warn(`[github-app] installation token unavailable, falling back: ${err?.message || err}`);
  }
  return process.env.GITHUB_TOKEN ? `Bearer ${process.env.GITHUB_TOKEN}` : null;
}

/** HTTPS clone URL carrying an installation token (for in-cluster builds), or null. */
export async function authenticatedCloneUrl(owner: string, repo: string): Promise<string | null> {
  const app = await loadGithubApp();
  if (!app) return null;
  const inst = await findInstallationForRepo(owner, repo);
  if (!inst) return null;
  const token = await getInstallationToken(inst.installationId, app);
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repo}.git`;
}

function repoNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((r: any) => String(r?.full_name || '').toLowerCase())
    .filter((n) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(n));
}

async function upsertInstallation(fields: Partial<GitAppInstallation> & { installationId: string }): Promise<GitAppInstallation> {
  const repo = await installationRepo();
  const existing = await repo.findOne({ where: { installationId: fields.installationId } });
  const row = existing ? Object.assign(existing, fields) : repo.create({ repositories: [], repositorySelection: 'selected', suspendedAt: null, ...fields });
  return (await repo.save(row)) as GitAppInstallation;
}

/**
 * Apply an `installation` / `installation_repositories` webhook (signature already verified).
 * Events for a different App id are ignored.
 */
export async function handleInstallationWebhook(event: string, payload: any): Promise<{ handled: boolean; message: string }> {
  const inst = payload?.installation;
  const installationId = inst?.id != null ? String(inst.id) : '';
  if (!/^\d{1,20}$/.test(installationId)) return { handled: false, message: 'No installation in payload' };
  const app = await loadProviderApp('github');
  if (app?.appId && inst.app_id != null && String(inst.app_id) !== app.appId) {
    return { handled: false, message: 'Installation belongs to another App' };
  }
  const repo = await installationRepo();
  const action = String(payload?.action || '');
  const accountLogin = String(inst.account?.login || '');
  const accountType = inst.account?.type ? String(inst.account.type) : null;
  const selection = inst.repository_selection === 'all' ? 'all' : 'selected';

  if (event === 'installation') {
    if (action === 'deleted') {
      await repo.delete({ installationId });
      await dropCachedToken(app?.appId, installationId);
      return { handled: true, message: 'Installation removed' };
    }
    if (action === 'suspend') {
      await upsertInstallation({ installationId, accountLogin, accountType, repositorySelection: selection, suspendedAt: new Date() });
      await dropCachedToken(app?.appId, installationId);
      return { handled: true, message: 'Installation suspended' };
    }
    const fields: Partial<GitAppInstallation> & { installationId: string } = {
      installationId, accountLogin, accountType, repositorySelection: selection, suspendedAt: null,
    };
    if (Array.isArray(payload?.repositories)) fields.repositories = repoNames(payload.repositories);
    await upsertInstallation(fields);
    return { handled: true, message: `Installation ${action || 'updated'}` };
  }

  if (event === 'installation_repositories') {
    const existing = await repo.findOne({ where: { installationId } });
    const current = new Set(existing?.repositories || []);
    for (const n of repoNames(payload?.repositories_added)) current.add(n);
    for (const n of repoNames(payload?.repositories_removed)) current.delete(n);
    const sel = payload?.repository_selection === 'all' ? 'all' : selection;
    await upsertInstallation({ installationId, accountLogin, accountType, repositorySelection: sel, repositories: [...current].sort() });
    return { handled: true, message: 'Installation repositories updated' };
  }
  return { handled: false, message: 'Event ignored' };
}

async function dropCachedToken(appId: string | null | undefined, installationId: string): Promise<void> {
  if (!appId) return;
  const key = tokenCacheKey(appId, installationId);
  memoryTokens.delete(key);
  if (stateBackend() === 'redis') {
    try { await withRedis((r) => r.del(redisKey(key))); } catch { /* expires on its own */ }
  }
}

/** Repositories an installation token can see (GET /installation/repositories, paginated). */
export async function fetchInstallationRepositories(installationId: string, app?: GithubAppCredentials | null) {
  const token = await getInstallationToken(installationId, app);
  const out: { fullName: string; private: boolean; cloneUrl: string; defaultBranch: string; htmlUrl: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${GITHUB_API}/installation/repositories?per_page=100&page=${page}`, {
      redirect: 'error',
      headers: appHeaders(token),
    });
    if (!res.ok) throw new GithubAppError(`GitHub repository listing failed (${res.status})`, 502);
    const data: any = await res.json();
    const repos: any[] = Array.isArray(data?.repositories) ? data.repositories : [];
    for (const r of repos) {
      out.push({
        fullName: String(r.full_name),
        private: Boolean(r.private),
        cloneUrl: String(r.clone_url || `${GITHUB_WEB}/${r.full_name}.git`),
        defaultBranch: String(r.default_branch || 'main'),
        htmlUrl: String(r.html_url || ''),
      });
    }
    if (repos.length < 100) break;
  }
  return out;
}

/** Re-read every installation of the App from GitHub (recovers from missed webhooks). */
export async function syncInstallations(): Promise<GitAppInstallation[]> {
  const app = await loadGithubApp();
  if (!app) throw new GithubAppError('GitHub App is not connected', 409);
  const res = await fetch(`${GITHUB_API}/app/installations?per_page=100`, {
    redirect: 'error',
    headers: appHeaders(signAppJwt(app.appId, app.privateKey)),
  });
  if (!res.ok) throw new GithubAppError(`GitHub installation listing failed (${res.status})`, 502);
  const list: any[] = await res.json();
  const repo = await installationRepo();
  const seen = new Set<string>();
  for (const inst of Array.isArray(list) ? list : []) {
    const installationId = String(inst.id);
    if (!/^\d{1,20}$/.test(installationId)) continue;
    seen.add(installationId);
    const selection = inst.repository_selection === 'all' ? 'all' : 'selected';
    let repositories: string[] = [];
    if (selection === 'selected' && !inst.suspended_at) {
      repositories = (await fetchInstallationRepositories(installationId, app)).map((r) => r.fullName.toLowerCase());
    }
    await upsertInstallation({
      installationId,
      accountLogin: String(inst.account?.login || ''),
      accountType: inst.account?.type ? String(inst.account.type) : null,
      repositorySelection: selection,
      repositories,
      suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
    });
  }
  for (const row of await listInstallations()) {
    if (!seen.has(row.installationId)) await repo.delete({ installationId: row.installationId });
  }
  return listInstallations();
}

/** Projects whose repository URL is covered by `inst`. */
export function projectsForInstallation<P extends { id: string; name: string; repositoryUrl?: string | null }>(inst: GitAppInstallation, projects: P[]): P[] {
  return projects.filter((p) => {
    const remote = parseGitRemote(p.repositoryUrl || null);
    return remote?.provider === 'github' && installationCoversRepo(inst, remote.owner, remote.repo);
  });
}

/** GET /app with the App JWT: proves the stored id + private key are valid. */
export async function checkGithubAppHealth(): Promise<{ ok: boolean; error: string | null; name?: string }> {
  const app = await loadGithubApp();
  if (!app) return { ok: false, error: 'GitHub App is not connected or its credentials cannot be decrypted' };
  try {
    const res = await fetch(`${GITHUB_API}/app`, { redirect: 'error', headers: appHeaders(signAppJwt(app.appId, app.privateKey)) });
    if (!res.ok) {
      const error = `GitHub answered ${res.status}`;
      await recordHealth('github', false, error);
      return { ok: false, error };
    }
    const data: any = await res.json();
    await recordHealth('github', true, null);
    return { ok: true, error: null, name: data?.name };
  } catch (err: any) {
    const error = String(err?.message || err);
    await recordHealth('github', false, error);
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Webhook signatures
// ---------------------------------------------------------------------------

/** Constant-time check of `X-Hub-Signature-256` against any of `secrets`. */
export function verifyHubSignature(payload: unknown, signature: string | undefined, secrets: string[]): boolean {
  if (!Buffer.isBuffer(payload) || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const supplied = Buffer.from(signature);
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex'));
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) ok = true;
  }
  return ok;
}

/** Secrets accepted on /webhooks/github: the App's webhook secret and the legacy env secret. */
export async function githubWebhookSecrets(): Promise<string[]> {
  const out: string[] = [];
  const row = await loadProviderApp('github');
  if (row?.webhookSecretEnc) {
    try { out.push(decryptAppSecret(row.webhookSecretEnc)); } catch { /* undecryptable: ignore */ }
  }
  if (process.env.GITHUB_WEBHOOK_SECRET) out.push(process.env.GITHUB_WEBHOOK_SECRET);
  return out;
}
