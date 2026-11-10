import express, { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, requireHumanJwt, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { findOidcClient, isRegisteredRedirectUri, verifyClientSecret, OidcClient } from '../lib/oidc-clients';
import { getOidcSigningKey, getOidcVerificationKeys, rotateOidcSigningKey } from '../lib/oidc-keys';
import { getOidcIssuer } from '../lib/oidc-issuer';
import { createCodeStore, verifyPkceS256 } from '../lib/oidc-codes';
import { StateStoreUnavailableError } from '../lib/redis';
import { completeFirstFactor, loginResponseBody } from '../lib/mfa';
import { AMR_FEDERATED } from '../lib/session-token';
import {
  buildAuthorizeUrl,
  completeOAuthCallback,
  loginFailedRedirect,
  exchangeLoginCode,
  stateCookieHeader,
  clearStateCookieHeader,
  readCookie,
  OAUTH_STATE_COOKIE,
} from '../lib/oauth-login';

/**
 * Built-in OIDC provider (/api/oauth/*) used by Grafana, Argo CD, Portainer, oauth2-proxy
 * and MinIO, plus the GitHub/GitLab portal login flow and its code exchange.
 *
 * Mounted before the auth router in routes/api.ts, so the /auth/github|gitlab handlers here
 * (which bind `state` to the browser with a cookie) take precedence over older copies.
 */
const router = Router();

const AUTH_CODE_TTL_MS = 2 * 60 * 1000;
const TOKEN_TTL_SECONDS = 3600;

interface AuthCodeSession {
  userId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  nonce: string | null;
  codeChallenge: string | null;
  authTime: number;
  /** Authentication methods of the portal session that approved the request (#24). */
  amr?: string[];
}

/** Authorization codes live in Redis (shared by all replicas; GETDEL = single use). */
export const oidcAuthCodes = createCodeStore<AuthCodeSession>('oidc-code', AUTH_CODE_TTL_MS);

function requestProto(req: Request): string {
  return (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
}

/** Portal origin for the consent hand-off. Uses configuration first; Host only in local dev. */
function portalBaseFor(req: Request): string {
  if (process.env.PORTAL_URL) return process.env.PORTAL_URL.replace(/\/+$/, '');
  const domain = String(process.env.DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (domain) return `https://${domain}`;
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (host.startsWith('api.')) return `${protocol}://${host.substring(4)}`;
  if (host.includes(':3000')) return `${protocol}://${host.replace(':3000', ':4200')}`;
  return `${protocol}://${host}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Validate client_id + redirect_uri + response_type/PKCE params shared by GET and POST /oauth/authorize. */
interface AuthorizeValidation {
  ok: boolean;
  client?: OidcClient;
  redirectUri?: string;
  status?: number;
  error?: string;
  description?: string;
  /** Set when redirect_uri is registered, so the error may be returned to the client per RFC 6749 4.1.2.1. */
  redirectable?: { redirectUri: string };
}

function validateAuthorizeParams(p: Record<string, unknown>): AuthorizeValidation {
  const client = findOidcClient(p.client_id);
  if (!client) {
    return { ok: false, status: 400, error: 'invalid_client', description: 'Unknown client_id' };
  }
  const redirectUri = str(p.redirect_uri);
  if (!isRegisteredRedirectUri(client, redirectUri)) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'redirect_uri is not registered for this client' };
  }
  const responseType = str(p.response_type) || 'code';
  if (responseType !== 'code') {
    return { ok: false, status: 400, error: 'unsupported_response_type', description: 'Only response_type=code is supported', redirectable: { redirectUri } };
  }
  if (str(p.code_challenge)) {
    if (str(p.code_challenge_method) !== 'S256') {
      return { ok: false, status: 400, error: 'invalid_request', description: 'code_challenge_method must be S256', redirectable: { redirectUri } };
    }
    if (!/^[A-Za-z0-9\-_]{43}$/.test(str(p.code_challenge))) {
      return { ok: false, status: 400, error: 'invalid_request', description: 'Malformed code_challenge', redirectable: { redirectUri } };
    }
  }
  return { ok: true, client, redirectUri };
}

function appendParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}

function oauthError(res: Response, status: number, error: string, description: string) {
  return res.status(status).json({ error, error_description: description });
}

// ---------------------------------------------------------------------------
// Discovery + keys
// ---------------------------------------------------------------------------

router.get('/oauth/.well-known/openid-configuration', (_req: Request, res: Response) => {
  const baseUrl = getOidcIssuer();
  return res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    jwks_uri: `${baseUrl}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'amr', 'name', 'email', 'email_verified', 'groups', 'roles', 'nonce'],
  });
});

router.get('/oauth/jwks', (_req: Request, res: Response) => {
  try {
    // Current key first; the key retired by the last rotation stays published
    // so tokens it signed keep verifying until they expire.
    const keys = getOidcVerificationKeys().map((key) => {
      const jwk = crypto.createPublicKey(key.publicKey).export({ format: 'jwk' }) as any;
      return { kid: key.kid, use: 'sig', alg: 'RS256', kty: 'RSA', n: jwk.n, e: jwk.e };
    });
    return res.json({ keys });
  } catch (err: any) {
    console.error('[oidc] jwks unavailable:', err.message);
    return res.status(500).json({ error: 'OIDC signing key is not available' });
  }
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

/**
 * GET /api/oauth/authorize — browser entry point from a relying party.
 * Validates client + exact redirect_uri, then hands off to the portal consent screen.
 * Never redirects to an unregistered URI. Session tokens are not accepted in the query string.
 */
router.get('/oauth/authorize', (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  const v = validateAuthorizeParams(q);
  if (!v.ok) {
    if (v.redirectable) {
      return res.redirect(appendParams(v.redirectable.redirectUri, { error: v.error!, error_description: v.description!, state: str(q.state) }));
    }
    return oauthError(res, v.status!, v.error!, v.description!);
  }

  const params = new URLSearchParams();
  params.set('client_id', v.client!.id);
  params.set('redirect_uri', v.redirectUri!);
  params.set('response_type', 'code');
  params.set('scope', str(q.scope) || 'openid');
  for (const k of ['state', 'nonce', 'code_challenge', 'code_challenge_method']) {
    if (str(q[k])) params.set(k, str(q[k]));
  }
  return res.redirect(`${portalBaseFor(req)}/oauth/authorize?${params.toString()}`);
});

/** GET /api/oauth/clients/:id — public client info for the portal consent screen. */
router.get('/oauth/clients/:id', (req: Request, res: Response) => {
  const client = findOidcClient(req.params.id);
  if (!client) return oauthError(res, 404, 'invalid_client', 'Unknown client_id');
  const redirectUri = str(req.query.redirect_uri);
  return res.json({
    client_id: client.id,
    name: client.name,
    redirect_uri_valid: redirectUri ? isRegisteredRedirectUri(client, redirectUri) : undefined,
  });
});

/**
 * POST /api/oauth/authorize — called by the portal consent screen after the user approves.
 * Auth: human session JWT in the Authorization header (never in the URL).
 * Returns { redirect: "<registered redirect_uri>?code=...&state=..." }.
 */
router.post('/oauth/authorize', expressAuthenticate, requireHumanJwt, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const body = (req.body || {}) as Record<string, unknown>;
  const v = validateAuthorizeParams(body);
  if (!v.ok) return oauthError(res, v.status!, v.error!, v.description!);

  const portalSession = authReq.session;
  const now = Math.floor(Date.now() / 1000);
  let code: string;
  try {
    code = await oidcAuthCodes.issue({
      userId: authReq.user!.id,
      clientId: v.client!.id,
      redirectUri: v.redirectUri!,
      scope: str(body.scope) || 'openid',
      nonce: str(body.nonce) || null,
      codeChallenge: str(body.code_challenge) || null,
      // When the user signed in to the portal and with which methods: downstream tools can
      // require `mfa` in `amr` or a recent `auth_time`.
      authTime: typeof portalSession?.authTime === 'number' && portalSession.authTime <= now ? portalSession.authTime : now,
      amr: portalSession?.amr?.length ? portalSession.amr : undefined,
    });
  } catch (err) {
    // Fail closed: without the shared store the code could not be redeemed on another replica.
    if (err instanceof StateStoreUnavailableError) {
      return oauthError(res, 503, 'temporarily_unavailable', 'Authorization is temporarily unavailable');
    }
    return oauthError(res, 500, 'server_error', 'Could not issue an authorization code');
  }
  return res.json({ redirect: appendParams(v.redirectUri!, { code, state: str(body.state) }) });
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

function decodeFormComponent(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** client_secret_basic (preferred) or client_secret_post. */
function readClientCredentials(req: Request): { id: string; secret: string; method: 'basic' | 'post' } | null {
  const header = req.headers.authorization;
  if (header && header.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { id: decodeFormComponent(decoded.slice(0, idx)), secret: decodeFormComponent(decoded.slice(idx + 1)), method: 'basic' };
  }
  const id = str(req.body?.client_id);
  const secret = str(req.body?.client_secret);
  if (!id || !secret) return null;
  return { id, secret, method: 'post' };
}

router.post('/oauth/token', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const body = (req.body || {}) as Record<string, unknown>;

    const creds = readClientCredentials(req);
    const client = creds ? findOidcClient(creds.id) : null;
    if (!creds || !client || !verifyClientSecret(client, creds.secret)) {
      if (creds?.method === 'basic') res.set('WWW-Authenticate', 'Basic realm="platform-oidc"');
      return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
    }
    if (str(body.client_id) && str(body.client_id) !== client.id) {
      return oauthError(res, 400, 'invalid_client', 'client_id does not match the authenticated client');
    }

    if (str(body.grant_type) !== 'authorization_code') {
      return oauthError(res, 400, 'unsupported_grant_type', 'Only grant_type=authorization_code is supported');
    }

    // Single use: the code is removed whether or not the rest of the checks pass.
    let session: AuthCodeSession | null;
    try {
      session = await oidcAuthCodes.consume(body.code);
    } catch (err) {
      if (err instanceof StateStoreUnavailableError) {
        return oauthError(res, 503, 'temporarily_unavailable', 'Token exchange is temporarily unavailable');
      }
      throw err;
    }
    if (!session) {
      return oauthError(res, 400, 'invalid_grant', 'Invalid or expired authorization code');
    }
    if (session.clientId !== client.id) {
      return oauthError(res, 400, 'invalid_grant', 'Authorization code was issued to another client');
    }
    if (str(body.redirect_uri) !== session.redirectUri) {
      return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (session.codeChallenge && !verifyPkceS256(body.code_verifier, session.codeChallenge)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    }

    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { id: session.userId } });
    if (!user || user.isActive === false) {
      return oauthError(res, 400, 'invalid_grant', 'User is not active');
    }

    const key = getOidcSigningKey();
    const issuer = getOidcIssuer();
    const now = Math.floor(Date.now() / 1000);

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, scope: session.scope, ...(session.amr ? { amr: session.amr } : {}) },
      key.privateKey,
      { algorithm: 'RS256', expiresIn: TOKEN_TTL_SECONDS, issuer, audience: client.id, subject: user.id, keyid: key.kid },
    );

    const idToken = jwt.sign(
      {
        iss: issuer,
        sub: user.id,
        aud: client.id,
        exp: now + TOKEN_TTL_SECONDS,
        iat: now,
        auth_time: session.authTime,
        ...(session.amr ? { amr: session.amr } : {}),
        ...(session.nonce ? { nonce: session.nonce } : {}),
        name: user.name,
        email: user.email,
        email_verified: true,
        groups: [user.role],
        roles: [user.role],
      },
      key.privateKey,
      { algorithm: 'RS256', keyid: key.kid },
    );

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      id_token: idToken,
      scope: session.scope,
    });
  } catch (err: any) {
    console.error('[oidc] token endpoint error:', err?.message || err);
    return oauthError(res, 500, 'server_error', 'Token issuance failed');
  }
});

// ---------------------------------------------------------------------------
// UserInfo
// ---------------------------------------------------------------------------

router.get('/oauth/userinfo', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header with Bearer token is required' });
    }
    const token = authHeader.slice(7);

    let decoded: any;
    const kid = (jwt.decode(token, { complete: true }) as any)?.header?.kid;
    const candidates = getOidcVerificationKeys().filter((k) => !kid || k.kid === kid);
    for (const key of candidates) {
      try {
        decoded = jwt.verify(token, key.publicKey, { algorithms: ['RS256'], issuer: getOidcIssuer() });
        break;
      } catch {
        /* try the next key */
      }
    }
    if (!decoded) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { id: decoded.sub || decoded.id } });
    if (!user || user.isActive === false) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    return res.json({
      sub: user.id,
      name: user.name,
      email: user.email,
      email_verified: true,
      groups: [user.role],
      roles: [user.role],
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GitHub / GitLab portal login (state bound to the browser) + code exchange
// ---------------------------------------------------------------------------

function startProviderLogin(provider: 'github' | 'gitlab') {
  return async (req: Request, res: Response) => {
    const proto = requestProto(req);
    const built = await buildAuthorizeUrl(provider, req.get('host') || undefined, proto);
    if (!built.ok) return res.status(built.status).json({ error: built.error });
    res.append('Set-Cookie', stateCookieHeader(built.state, proto === 'https'));
    return res.redirect(built.url);
  };
}

function finishProviderLogin(provider: 'github' | 'gitlab') {
  return async (req: Request, res: Response) => {
    const proto = requestProto(req);
    res.append('Set-Cookie', clearStateCookieHeader(proto === 'https'));
    try {
      const result = await completeOAuthCallback({
        provider,
        code: typeof req.query.code === 'string' ? req.query.code : undefined,
        state: typeof req.query.state === 'string' ? req.query.state : undefined,
        browserState: readCookie(req.headers.cookie, OAUTH_STATE_COOKIE),
        reqHost: req.get('host') || undefined,
        proto,
      });
      return res.redirect(result.redirect);
    } catch (err: any) {
      const label = provider === 'github' ? 'GitHub' : 'GitLab';
      return res.redirect(loginFailedRedirect(req.get('host') || undefined, proto, err.message || `${label} login failed`));
    }
  };
}

router.get('/auth/github', startProviderLogin('github'));
router.get('/auth/github/callback', finishProviderLogin('github'));
router.get('/auth/gitlab', startProviderLogin('gitlab'));
router.get('/auth/gitlab/callback', finishProviderLogin('gitlab'));

/**
 * POST /api/auth/exchange { code } → { token, user }
 * Swaps the one-time code from /dashboard?code=... (GitHub/GitLab login) for a session JWT.
 * With MFA enabled it answers `{ mfa_required: true, challengeToken }` instead (no session
 * before the second factor; POST /api/auth/mfa/challenge completes the login).
 */
router.post('/auth/exchange', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await exchangeLoginCode(req.body?.code);
    if (!result) return res.status(400).json({ error: 'Invalid or expired login code' });
    const outcome = await completeFirstFactor(result.user, [AMR_FEDERATED], req.ip);
    return res.json(loginResponseBody(outcome, result.user));
  } catch (err: any) {
    if (err instanceof StateStoreUnavailableError) {
      return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Try again in a moment.' });
    }
    return res.status(500).json({ error: 'Login code exchange failed' });
  }
});

/**
 * Rotate the OIDC signing key (admin, human JWT). The new key is written to
 * the platform-oidc-signing-key Secret with the old one kept as `previous`
 * (still in JWKS), then the API is restarted so every replica loads it.
 */
router.post('/oauth/signing-key/rotate', expressAuthenticate, requireHumanJwt, expressRequireRole([UserRole.ADMIN]), async (req: Request, res: Response) => {
  try {
    const key = await rotateOidcSigningKey();
    const authReq = req as AuthenticatedRequest;
    await logAudit({ userId: authReq.user?.id, action: 'oidc.signing_key.rotate', targetType: 'oidc', targetId: key.kid, ip: req.ip });
    try {
      const { restartNamedDeployment } = await import('../lib/k8s');
      await restartNamedDeployment('platform', 'platform-api');
    } catch (err: any) {
      console.warn(`[oidc] rotated signing key; API restart failed: ${err?.message || err}`);
    }
    return res.json({ kid: key.kid, previousKidRetained: true });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'rotation failed' });
  }
});

export default router;
