/**
 * GitLab OAuth application automation (#35). The admin pastes a token with the `api` scope
 * once; the platform creates the OAuth application used for "Sign in with GitLab" and stores
 * its credentials encrypted.
 *
 *  - Instance administrators (gitlab.com is never one; self-managed admins are):
 *    POST /api/v4/applications creates an instance-wide application.
 *  - Everyone else names a group they own: POST /api/v4/groups/:id/applications is tried; GitLab
 *    versions without that endpoint answer 404/405, and the caller gets `manualRequired` with
 *    the redirect URI to create the group application in the GitLab UI (manual fallback).
 *
 * The bootstrap token is NOT stored unless the admin opts in (`keepToken`): an OAuth app's own
 * credentials cannot act on projects (GitLab has no installation-token equivalent), so
 * registering project webhooks needs an api-scoped token. Opting in keeps it encrypted for
 * exactly that; otherwise it is discarded after the request and webhook registration uses
 * the manual linking token (GITLAB_TOKEN) as before.
 */
import * as crypto from 'crypto';
import { GitProviderApp } from '../entities/GitProviderApp';
import { decryptAppSecret, encryptAppSecret, loadProviderApp, recordHealth, saveProviderApp } from './git-app-store';

export const GITLAB_OAUTH_SCOPES = 'read_user read_api';

export class GitlabAppError extends Error {
  constructor(message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GitlabAppError';
  }
}

/** Normalise a GitLab base URL: HTTPS, no credentials/query/fragment, no trailing slash. */
export function normalizeGitlabBaseUrl(input: unknown): string {
  const raw = String(input || 'https://gitlab.com').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new GitlabAppError('GitLab URL is not a valid URL'); }
  if (url.protocol !== 'https:') throw new GitlabAppError('GitLab URL must use https');
  if (url.username || url.password || url.search || url.hash) throw new GitlabAppError('GitLab URL must not contain credentials, a query or a fragment');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

const GROUP_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

async function gitlabFetch(base: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}/api/v4${path}`, {
    ...init,
    redirect: 'error',
    headers: {
      'PRIVATE-TOKEN': token,
      Accept: 'application/json',
      'User-Agent': 'platform-api',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export interface ConnectGitlabInput {
  baseUrl?: unknown;
  token?: unknown;
  groupPath?: unknown;
  keepToken?: unknown;
  appName?: unknown;
  redirectUri: string;
  userId: string;
}

export async function connectGitlab(input: ConnectGitlabInput): Promise<{ row: GitProviderApp; mode: 'instance' | 'group'; tokenKept: boolean }> {
  const base = normalizeGitlabBaseUrl(input.baseUrl);
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!token || token.length > 500 || /\s/.test(token)) throw new GitlabAppError('Paste a GitLab token with the api scope');
  const groupPath = typeof input.groupPath === 'string' ? input.groupPath.trim().replace(/^\/+|\/+$/g, '') : '';
  if (groupPath && !GROUP_PATH_RE.test(groupPath)) throw new GitlabAppError('Group path is not valid');
  const keepToken = input.keepToken === true;

  const userRes = await gitlabFetch(base, '/user', token);
  if (userRes.status === 401 || userRes.status === 403) throw new GitlabAppError('GitLab rejected the token', 400);
  if (!userRes.ok) throw new GitlabAppError(`GitLab user lookup failed (${userRes.status})`, 502);
  const user: any = await userRes.json();

  // Personal/group/project tokens report their scopes here (GitLab 15+); older servers 404.
  const selfRes = await gitlabFetch(base, '/personal_access_tokens/self', token).catch(() => null);
  if (selfRes && selfRes.ok) {
    const self: any = await selfRes.json().catch(() => null);
    if (Array.isArray(self?.scopes) && !self.scopes.includes('api')) {
      throw new GitlabAppError('The token needs the api scope');
    }
  }

  const name = (typeof input.appName === 'string' && input.appName.trim().slice(0, 100)) || 'Platform login';
  const body = JSON.stringify({ name, redirect_uri: input.redirectUri, scopes: GITLAB_OAUTH_SCOPES, confidential: true });

  let mode: 'instance' | 'group';
  let created: any;
  if (!groupPath) {
    if (user?.is_admin !== true) {
      throw new GitlabAppError(
        'This token does not belong to a GitLab instance administrator. Enter a group you own to create a group application instead.',
        400,
        { needsGroup: true },
      );
    }
    const res = await gitlabFetch(base, '/applications', token, { method: 'POST', body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabAppError(`GitLab application creation failed (${res.status}): ${text.slice(0, 200)}`, 502);
    }
    created = await res.json();
    mode = 'instance';
  } else {
    const res = await gitlabFetch(base, `/groups/${encodeURIComponent(groupPath)}/applications`, token, { method: 'POST', body });
    if (res.status === 404 || res.status === 405) {
      throw new GitlabAppError(
        'This GitLab version cannot create group applications through the API. Create one under the group\'s Settings > Applications and enter it under "Advanced: manual entry".',
        422,
        { manualRequired: true, redirectUri: input.redirectUri, scopes: GITLAB_OAUTH_SCOPES },
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitlabAppError(`GitLab group application creation failed (${res.status}): ${text.slice(0, 200)}`, 502);
    }
    created = await res.json();
    mode = 'group';
  }

  const clientId = created?.application_id ? String(created.application_id) : '';
  const secret = created?.secret ? String(created.secret) : '';
  if (!clientId || !secret) throw new GitlabAppError('GitLab returned an incomplete application', 502);

  const row = await saveProviderApp('gitlab', {
    appId: created?.id != null ? String(created.id) : null,
    owner: mode === 'group' ? groupPath : null,
    ownerType: mode,
    baseUrl: base,
    clientId,
    clientSecretEnc: encryptAppSecret(secret),
    // Random secret GitLab sends back as X-Gitlab-Token on the hooks this platform registers.
    webhookSecretEnc: encryptAppSecret(crypto.randomBytes(32).toString('hex')),
    apiTokenEnc: keepToken ? encryptAppSecret(token) : null,
    createdBy: input.userId,
  });
  return { row, mode, tokenKept: keepToken };
}

export interface GitlabAppCredentials {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  apiToken: string;
}

export async function loadGitlabApp(): Promise<GitlabAppCredentials | null> {
  const row = await loadProviderApp('gitlab');
  if (!row || !row.clientId || !row.clientSecretEnc) return null;
  try {
    return {
      baseUrl: row.baseUrl || 'https://gitlab.com',
      clientId: row.clientId,
      clientSecret: decryptAppSecret(row.clientSecretEnc),
      webhookSecret: decryptAppSecret(row.webhookSecretEnc),
      apiToken: decryptAppSecret(row.apiTokenEnc),
    };
  } catch {
    return null;
  }
}

/** API token for GitLab project calls: the kept bootstrap token first, then GITLAB_TOKEN. */
export async function gitlabApiToken(): Promise<string> {
  const app = await loadGitlabApp();
  return app?.apiToken || process.env.GITLAB_TOKEN || '';
}

/** Token + hook secret for registering GitLab project webhooks: stored first, env fallback. */
export async function gitlabWebhookCredentials(): Promise<{ apiToken: string; secret: string }> {
  const app = await loadGitlabApp();
  return {
    apiToken: app?.apiToken || process.env.GITLAB_TOKEN || '',
    secret: app?.webhookSecret || process.env.GITLAB_WEBHOOK_SECRET || process.env.GITLAB_WEBHOOK_TOKEN || '',
  };
}

/** Secrets accepted as X-Gitlab-Token on /webhooks/gitlab. */
export async function gitlabWebhookSecrets(): Promise<string[]> {
  const out: string[] = [];
  const app = await loadGitlabApp();
  if (app?.webhookSecret) out.push(app.webhookSecret);
  const env = process.env.GITLAB_WEBHOOK_SECRET || process.env.GITLAB_WEBHOOK_TOKEN;
  if (env) out.push(env);
  return out;
}

/** Constant-time comparison of a supplied X-Gitlab-Token against any accepted secret. */
export function verifyGitlabTokenAgainst(token: string | undefined, secrets: string[]): boolean {
  if (typeof token !== 'string' || !token) return false;
  const supplied = Buffer.from(token);
  let ok = false;
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(secret);
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) ok = true;
  }
  return ok;
}

/**
 * Health: with a kept token, GET /user proves it still works; otherwise check the instance is
 * reachable via its public OpenID configuration (the OAuth app itself can only be exercised
 * by a user signing in).
 */
export async function checkGitlabAppHealth(): Promise<{ ok: boolean; error: string | null }> {
  const app = await loadGitlabApp();
  if (!app) return { ok: false, error: 'GitLab application is not connected or its credentials cannot be decrypted' };
  try {
    const res = app.apiToken
      ? await gitlabFetch(app.baseUrl, '/user', app.apiToken)
      : await fetch(`${app.baseUrl}/.well-known/openid-configuration`, { redirect: 'error', headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const error = `GitLab answered ${res.status}`;
      await recordHealth('gitlab', false, error);
      return { ok: false, error };
    }
    await recordHealth('gitlab', true, null);
    return { ok: true, error: null };
  } catch (err: any) {
    const error = String(err?.message || err);
    await recordHealth('gitlab', false, error);
    return { ok: false, error };
  }
}
