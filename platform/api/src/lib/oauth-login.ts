import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { resolveIntegrations } from './integrations';
import { notifyUser } from './notify';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';
const oauthStates = new Map<string, { provider: 'github' | 'gitlab'; createdAt: number }>();

function portalBase(reqHost: string | undefined, proto: string): string {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL.replace(/\/+$/, '');
  const host = reqHost || 'localhost';
  if (host.startsWith('api.')) return `${proto}://${host.replace(/^api\./, '')}`;
  return `${proto}://${host}`;
}

function apiBase(reqHost: string | undefined, proto: string): string {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL.replace(/\/+$/, '');
  const host = reqHost || 'localhost';
  return `${proto}://${host}`;
}

export function issuePortalRedirect(token: string, reqHost: string | undefined, proto: string): string {
  return `${portalBase(reqHost, proto)}/dashboard?token=${encodeURIComponent(token)}`;
}

export function loginFailedRedirect(reqHost: string | undefined, proto: string, message: string): string {
  return `${portalBase(reqHost, proto)}/login?error=${encodeURIComponent(message)}`;
}

export async function buildAuthorizeUrl(
  provider: 'github' | 'gitlab',
  reqHost: string | undefined,
  proto: string,
): Promise<{ ok: boolean; url: string; error: string; status: number }> {
  const cfg = await resolveIntegrations();
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { provider, createdAt: Date.now() });
  const redirectUri = `${apiBase(reqHost, proto)}/api/auth/${provider}/callback`;

  if (provider === 'github') {
    if (!cfg.githubLoginEnabled) {
      return { ok: false, url: '', status: 400, error: 'GitHub login is not configured. Add a GitHub OAuth App under Settings → Login.' };
    }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', cfg.githubClientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', state);
    return { ok: true, url: url.toString(), error: '', status: 302 };
  }

  if (!cfg.gitlabLoginEnabled) {
    return { ok: false, url: '', status: 400, error: 'GitLab login is not configured. Add a GitLab OAuth application under Settings → Login.' };
  }
  const url = new URL(`${cfg.gitlabUrl}/oauth/authorize`);
  url.searchParams.set('client_id', cfg.gitlabClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'read_user');
  url.searchParams.set('state', state);
  return { ok: true, url: url.toString(), error: '', status: 302 };
}

async function exchangeGithub(code: string, redirectUri: string, cfg: Awaited<ReturnType<typeof resolveIntegrations>>) {
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
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/json', 'User-Agent': 'platform' },
  });
  const user: any = await userRes.json();
  let email = user.email as string | null;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/json', 'User-Agent': 'platform' },
    });
    const emails: any[] = await emailsRes.json();
    email = emails.find((e) => e.primary && e.verified)?.email || emails.find((e) => e.verified)?.email || emails[0]?.email;
  }
  if (!email) throw new Error('GitHub account has no email');
  return { id: String(user.id), name: user.name || user.login, email, avatarUrl: user.avatar_url || null };
}

async function exchangeGitlab(code: string, redirectUri: string, cfg: Awaited<ReturnType<typeof resolveIntegrations>>) {
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
  const userRes = await fetch(`${cfg.gitlabUrl}/api/v4/user`, {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const user: any = await userRes.json();
  const email = user.email || user.public_email;
  if (!email) throw new Error('GitLab account has no email');
  return { id: String(user.id), name: user.name || user.username, email, avatarUrl: user.avatar_url || null };
}

export async function completeOAuthCallback(params: {
  provider: 'github' | 'gitlab';
  code?: string;
  state?: string;
  reqHost?: string;
  proto: string;
}): Promise<{ redirect: string }> {
  const { provider, code, state, reqHost, proto } = params;
  if (!code) return { redirect: loginFailedRedirect(reqHost, proto, 'Missing OAuth code') };
  const st = state ? oauthStates.get(state) : null;
  if (!st || st.provider !== provider) {
    return { redirect: loginFailedRedirect(reqHost, proto, 'Invalid OAuth state. Try signing in again.') };
  }
  oauthStates.delete(state!);

  const cfg = await resolveIntegrations();
  const redirectUri = `${apiBase(reqHost, proto)}/api/auth/${provider}/callback`;
  const profile = provider === 'github'
    ? await exchangeGithub(code, redirectUri, cfg)
    : await exchangeGitlab(code, redirectUri, cfg);

  const ds = await getDb();
  const repo = ds.getRepository(User);
  let user = provider === 'github'
    ? await repo.findOne({ where: { githubId: profile.id } })
    : await repo.findOne({ where: { gitlabId: profile.id } });
  if (!user) {
    user = await repo.findOne({ where: { email: profile.email } });
  }
  if (!user) {
    user = repo.create({
      id: uuidv4(),
      name: profile.name,
      email: profile.email,
      role: UserRole.DEVELOPER,
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

  const token = jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
  await notifyUser({
    userId: user.id,
    title: `Signed in with ${provider === 'github' ? 'GitHub' : 'GitLab'}`,
    body: `Welcome back, ${user.name}.`,
    kind: 'auth',
    link: '/profile',
  });
  return { redirect: issuePortalRedirect(token, reqHost, proto) };
}
