import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { resolveIntegrations } from './integrations';
import { notifyUser } from './notify';
import { OneTimeCodeStore } from './oidc-codes';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';

/** Browser-binding cookie for the GitHub/GitLab login `state` (login-CSRF protection). */
export const OAUTH_STATE_COOKIE = 'plat_oauth_state';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** One-time code the portal swaps for a session JWT via POST /api/auth/exchange. */
export const LOGIN_EXCHANGE_TTL_MS = 60 * 1000;

type Provider = 'github' | 'gitlab';

const oauthStates = new Map<string, { provider: Provider; createdAt: number }>();
const loginExchangeCodes = new OneTimeCodeStore<{ userId: string }>(LOGIN_EXCHANGE_TTL_MS);

function purgeStates() {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [k, v] of oauthStates) {
    if (v.createdAt < cutoff) oauthStates.delete(k);
  }
}

function configuredDomain(): string {
  return String(process.env.DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

function portalBase(reqHost: string | undefined, proto: string): string {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL.replace(/\/+$/, '');
  // Prefer configuration over the request Host header so a spoofed Host cannot redirect login codes.
  const domain = configuredDomain();
  if (domain) return `https://${domain}`;
  const host = reqHost || 'localhost';
  if (host.startsWith('api.')) return `${proto}://${host.replace(/^api\./, '')}`;
  return `${proto}://${host}`;
}

function apiBase(reqHost: string | undefined, proto: string): string {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL.replace(/\/+$/, '');
  const domain = configuredDomain();
  if (domain) return `https://${domain}`;
  const host = reqHost || 'localhost';
  return `${proto}://${host}`;
}

function csvEnv(name: string): string[] {
  return String(process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Issue a single-use, 60-second exchange code for the user and return the portal URL carrying it.
 * The session JWT itself never appears in a URL.
 */
export function issuePortalRedirect(userId: string, reqHost: string | undefined, proto: string): string {
  const code = loginExchangeCodes.issue({ userId });
  return `${portalBase(reqHost, proto)}/dashboard?code=${encodeURIComponent(code)}`;
}

export function loginFailedRedirect(reqHost: string | undefined, proto: string, message: string): string {
  return `${portalBase(reqHost, proto)}/login?error=${encodeURIComponent(message)}`;
}

/** Sign the portal session JWT (same shape as password login). */
export function signSessionToken(user: Pick<User, 'id' | 'email' | 'name' | 'role'>): string {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

/** Redeem a login exchange code. Returns null when unknown, expired, reused, or the user is inactive. */
export async function exchangeLoginCode(code: unknown): Promise<{ token: string; user: User } | null> {
  const entry = loginExchangeCodes.consume(code);
  if (!entry) return null;
  const ds = await getDb();
  const user = await ds.getRepository(User).findOne({ where: { id: entry.userId } });
  if (!user || user.isActive === false) return null;
  return { token: signSessionToken(user), user };
}

export function stateCookieHeader(state: string, secure: boolean): string {
  return [
    `${OAUTH_STATE_COOKIE}=${state}`,
    'Path=/',
    `Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearStateCookieHeader(secure: boolean): string {
  return [`${OAUTH_STATE_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function buildAuthorizeUrl(
  provider: Provider,
  reqHost: string | undefined,
  proto: string,
): Promise<{ ok: boolean; url: string; error: string; status: number; state: string }> {
  const cfg = await resolveIntegrations();
  const wantOrgs = csvEnv('OAUTH_ALLOWED_ORGS').length > 0;
  const redirectUri = `${apiBase(reqHost, proto)}/api/auth/${provider}/callback`;

  if (provider === 'github') {
    if (!cfg.githubLoginEnabled) {
      return { ok: false, url: '', status: 400, state: '', error: 'GitHub login is not configured. Add a GitHub OAuth App under Settings → Login.' };
    }
  } else if (!cfg.gitlabLoginEnabled) {
    return { ok: false, url: '', status: 400, state: '', error: 'GitLab login is not configured. Add a GitLab OAuth application under Settings → Login.' };
  }

  purgeStates();
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider, createdAt: Date.now() });

  if (provider === 'github') {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', cfg.githubClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', wantOrgs ? 'read:user user:email read:org' : 'read:user user:email');
    url.searchParams.set('state', state);
    return { ok: true, url: url.toString(), error: '', status: 302, state };
  }

  const url = new URL(`${cfg.gitlabUrl}/oauth/authorize`);
  url.searchParams.set('client_id', cfg.gitlabClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', wantOrgs ? 'read_user read_api' : 'read_user');
  url.searchParams.set('state', state);
  return { ok: true, url: url.toString(), error: '', status: 302, state };
}

interface ProviderProfile {
  id: string;
  name: string;
  /** Only ever a provider-verified address; null when the provider reports none. */
  verifiedEmail: string | null;
  avatarUrl: string | null;
  orgs: string[];
}

async function exchangeGithub(code: string, redirectUri: string, cfg: Awaited<ReturnType<typeof resolveIntegrations>>): Promise<ProviderProfile> {
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.githubClientId,
      client_secret: cfg.githubClientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson: any = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error(tokenJson.error_description || 'GitHub token exchange failed');
  const headers = { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/json', 'User-Agent': 'platform' };
  const userRes = await fetch('https://api.github.com/user', { headers });
  const user: any = await userRes.json();
  if (!user?.id) throw new Error('GitHub user lookup failed');

  // The profile `email` field is user-editable and unverified — only trust /user/emails primary+verified.
  const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
  const emails: any = await emailsRes.json();
  const primary = Array.isArray(emails) ? emails.find((e: any) => e && e.primary === true && e.verified === true) : null;

  let orgs: string[] = [];
  if (csvEnv('OAUTH_ALLOWED_ORGS').length > 0) {
    const orgRes = await fetch('https://api.github.com/user/orgs?per_page=100', { headers });
    const orgJson: any = await orgRes.json();
    orgs = Array.isArray(orgJson) ? orgJson.map((o: any) => String(o?.login || '').toLowerCase()).filter(Boolean) : [];
  }

  return {
    id: String(user.id),
    name: user.name || user.login,
    verifiedEmail: primary?.email ? String(primary.email) : null,
    avatarUrl: user.avatar_url || null,
    orgs,
  };
}

async function exchangeGitlab(code: string, redirectUri: string, cfg: Awaited<ReturnType<typeof resolveIntegrations>>): Promise<ProviderProfile> {
  const body = new URLSearchParams({
    client_id: cfg.gitlabClientId,
    client_secret: cfg.gitlabClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const tokenRes = await fetch(`${cfg.gitlabUrl}/oauth/token`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body,
  });
  const tokenJson: any = await tokenRes.json();
  if (!tokenJson.access_token) throw new Error(tokenJson.error_description || 'GitLab token exchange failed');
  const headers = { Authorization: `Bearer ${tokenJson.access_token}` };
  const userRes = await fetch(`${cfg.gitlabUrl}/api/v4/user`, { headers });
  const user: any = await userRes.json();
  if (!user?.id) throw new Error('GitLab user lookup failed');

  // `email` is the primary address; trust it only when the account is confirmed. Never use public_email.
  const verifiedEmail = user.email && user.confirmed_at ? String(user.email) : null;

  let orgs: string[] = [];
  if (csvEnv('OAUTH_ALLOWED_ORGS').length > 0) {
    const groupsRes = await fetch(`${cfg.gitlabUrl}/api/v4/groups?min_access_level=10&per_page=100`, { headers });
    const groups: any = await groupsRes.json();
    orgs = Array.isArray(groups)
      ? groups.flatMap((g: any) => [g?.full_path, g?.path]).filter(Boolean).map((s: string) => s.toLowerCase())
      : [];
  }

  return { id: String(user.id), name: user.name || user.username, verifiedEmail, avatarUrl: user.avatar_url || null, orgs };
}

/** Enforce OAUTH_ALLOWED_DOMAINS / OAUTH_ALLOWED_ORGS. Each configured list must be satisfied. */
export function checkOAuthAllowlist(profile: { verifiedEmail: string | null; orgs: string[] }): string | null {
  const domains = csvEnv('OAUTH_ALLOWED_DOMAINS');
  if (domains.length > 0) {
    const domain = profile.verifiedEmail?.split('@').pop()?.toLowerCase() || '';
    if (!domain || !domains.includes(domain)) {
      return 'Your email domain is not allowed to sign in.';
    }
  }
  const orgs = csvEnv('OAUTH_ALLOWED_ORGS');
  if (orgs.length > 0 && !profile.orgs.some((o) => orgs.includes(o))) {
    return 'You are not a member of an allowed organization.';
  }
  return null;
}

export async function completeOAuthCallback(params: {
  provider: Provider;
  code?: string;
  state?: string;
  /** Value of the httpOnly state cookie set when the flow started (binds the flow to this browser). */
  browserState?: string;
  reqHost?: string;
  proto: string;
}): Promise<{ redirect: string }> {
  const { provider, code, state, browserState, reqHost, proto } = params;
  if (!code) return { redirect: loginFailedRedirect(reqHost, proto, 'Missing OAuth code') };
  const invalidState = { redirect: loginFailedRedirect(reqHost, proto, 'Invalid OAuth state. Try signing in again.') };
  if (!state || !browserState || !safeEqual(state, browserState)) return invalidState;
  const st = oauthStates.get(state);
  oauthStates.delete(state);
  if (!st || st.provider !== provider || Date.now() - st.createdAt > OAUTH_STATE_TTL_MS) return invalidState;

  const cfg = await resolveIntegrations();
  const redirectUri = `${apiBase(reqHost, proto)}/api/auth/${provider}/callback`;
  const profile = provider === 'github'
    ? await exchangeGithub(code, redirectUri, cfg)
    : await exchangeGitlab(code, redirectUri, cfg);

  const denied = checkOAuthAllowlist(profile);
  if (denied) return { redirect: loginFailedRedirect(reqHost, proto, denied) };

  const ds = await getDb();
  const repo = ds.getRepository(User);
  let user = provider === 'github'
    ? await repo.findOne({ where: { githubId: profile.id } })
    : await repo.findOne({ where: { gitlabId: profile.id } });
  if (!user && profile.verifiedEmail) {
    // Link only by a provider-verified address.
    user = await repo.findOne({ where: { email: profile.verifiedEmail } });
  }
  if (!user) {
    if (!profile.verifiedEmail) {
      return {
        redirect: loginFailedRedirect(
          reqHost,
          proto,
          `Your ${provider === 'github' ? 'GitHub' : 'GitLab'} account needs a verified primary email address.`,
        ),
      };
    }
    user = repo.create({
      id: uuidv4(),
      name: profile.name,
      email: profile.verifiedEmail,
      // Self-registered OAuth users start with the least privilege; an admin can promote them.
      role: UserRole.VIEWER,
      gitlabId: provider === 'gitlab' ? profile.id : null,
      githubId: provider === 'github' ? profile.id : null,
      avatarUrl: profile.avatarUrl,
      lastLogin: new Date(),
      isActive: true,
    });
  } else {
    user.lastLogin = new Date();
    user.avatarUrl = profile.avatarUrl || user.avatarUrl;
    if (provider === 'github') user.githubId = profile.id;
    if (provider === 'gitlab') user.gitlabId = profile.id;
  }
  if (user.isActive === false) {
    return { redirect: loginFailedRedirect(reqHost, proto, 'Account is inactive') };
  }
  await repo.save(user);

  await notifyUser({
    userId: user.id,
    title: `Signed in with ${provider === 'github' ? 'GitHub' : 'GitLab'}`,
    body: `Welcome back, ${user.name}.`,
    kind: 'auth',
    link: '/profile',
  });
  return { redirect: issuePortalRedirect(user.id, reqHost, proto) };
}
