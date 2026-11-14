import express, { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, requireHumanJwt, hasRecentMfa, stepUpMaxAgeSec, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { findOidcClient, isRegisteredRedirectUri, verifyClientSecret, OidcClient } from '../lib/oidc-clients';
import { getOidcSigningKey, getOidcVerificationKeys, rotateOidcSigningKey } from '../lib/oidc-keys';
import { getOidcIssuer } from '../lib/oidc-issuer';
import { createCodeStore, verifyPkceS256 } from '../lib/oidc-codes';
import { StateStoreUnavailableError } from '../lib/redis';
import { completeFirstFactor, isMfaEnabled, loginResponseBody } from '../lib/mfa';
import { OAuthClient } from '../entities/OAuthClient';
import { McpGrant } from '../entities/McpGrant';
import {
  REGISTRATION_MAX_BYTES,
  hashClientIp,
  prepareRegistrationSlot,
  findActiveGrant,
  findMcpClient,
  isMcpClientId,
  issueTokens,
  newClientId,
  redeemRefreshToken,
  revokeToken,
  upsertGrant,
  validateGrantedScopes,
  validateRegistration,
} from '../lib/mcp-oauth';
import { allowedScopesForRole, consentScopeOptions, effectiveScopes, parseScopeParam } from '../lib/mcp-scopes';
import {
  MCP_UNCONFIGURED_MESSAGE,
  authorizationServerMetadata,
  getMcpResourceUrl,
  isOurMcpResource,
} from '../lib/mcp-public-url';
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
  /** Set for remote MCP clients (#193): the approved grant and the resource it is bound to. */
  mcp?: { grantId: string; resource: string };
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

/** Portal page that explains a rejected remote MCP authorization request. */
function mcpAuthorizeErrorPage(req: Request, error: string, description: string): string {
  const params = new URLSearchParams({ error, error_description: description.slice(0, 200) });
  return `${portalBaseFor(req)}/oauth/authorize?${params.toString()}`;
}

/** Validated authorization request of a dynamically registered (remote MCP) client. */
interface McpAuthorizeValidation {
  ok: boolean;
  client?: OAuthClient;
  redirectUri?: string;
  resource?: string;
  requestedScopes?: string[];
  status?: number;
  error?: string;
  description?: string;
  redirectable?: { redirectUri: string };
}

/**
 * MCP clients (#193): exact redirect_uri match against the registration, response_type=code,
 * PKCE with S256 required, and `resource` (RFC 8707), when sent, must name this server's /mcp.
 */
async function validateMcpAuthorizeParams(p: Record<string, unknown>): Promise<McpAuthorizeValidation> {
  const resourceUrl = getMcpResourceUrl();
  if (!resourceUrl) {
    return { ok: false, status: 503, error: 'temporarily_unavailable', description: MCP_UNCONFIGURED_MESSAGE };
  }
  const client = await findMcpClient(p.client_id);
  if (!client) {
    return { ok: false, status: 400, error: 'invalid_client', description: 'Unknown client_id' };
  }
  const redirectUri = str(p.redirect_uri);
  if (!redirectUri || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'redirect_uri is not registered for this client' };
  }
  const redirectable = { redirectUri };
  if ((str(p.response_type) || 'code') !== 'code') {
    return { ok: false, status: 400, error: 'unsupported_response_type', description: 'Only response_type=code is supported', redirectable };
  }
  if (str(p.code_challenge_method) !== 'S256' || !/^[A-Za-z0-9\-_]{43}$/.test(str(p.code_challenge))) {
    return { ok: false, status: 400, error: 'invalid_request', description: 'PKCE with code_challenge_method=S256 is required', redirectable };
  }
  const resource = str(p.resource);
  if (resource && !isOurMcpResource(resource)) {
    return { ok: false, status: 400, error: 'invalid_target', description: 'resource must be this server\'s MCP endpoint', redirectable };
  }
  return { ok: true, client, redirectUri, resource: resourceUrl, requestedScopes: parseScopeParam(str(p.scope)) };
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
  // Static clients (Grafana, Argo CD, ...) use authorization_code with a client secret. The
  // remote MCP additions (registration, refresh, revocation, public clients) are listed too.
  return res.json({
    ...authorizationServerMetadata(),
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    userinfo_endpoint: `${baseUrl}/userinfo`,
    jwks_uri: `${baseUrl}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'amr', 'name', 'email', 'email_verified', 'groups', 'roles', 'nonce'],
  });
});

/** RFC 8414 metadata (also served at /.well-known/oauth-authorization-server by routes/mcp.ts). */
router.get('/oauth/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300');
  return res.json(authorizationServerMetadata());
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
router.get('/oauth/authorize', async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;
  if (isMcpClientId(q.client_id)) {
    try {
      const m = await validateMcpAuthorizeParams(q);
      if (!m.ok) {
        // Self-registered clients are not trusted redirect targets until a person approves the
        // request, so errors are shown on our own page instead of being sent back (RFC 9700 4.11.2).
        return res.redirect(mcpAuthorizeErrorPage(req, m.error!, m.description!));
      }
      const params = new URLSearchParams();
      params.set('client_id', m.client!.clientId);
      params.set('redirect_uri', m.redirectUri!);
      params.set('response_type', 'code');
      params.set('resource', m.resource!);
      if (m.requestedScopes!.length) params.set('scope', m.requestedScopes!.join(' '));
      for (const k of ['state', 'code_challenge', 'code_challenge_method']) {
        if (str(q[k])) params.set(k, str(q[k]));
      }
      return res.redirect(`${portalBaseFor(req)}/oauth/authorize?${params.toString()}`);
    } catch {
      return oauthError(res, 500, 'server_error', 'Could not check the authorization request');
    }
  }
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
router.get('/oauth/clients/:id', async (req: Request, res: Response) => {
  if (isMcpClientId(req.params.id)) {
    const mcpClient = await findMcpClient(req.params.id).catch(() => null);
    if (!mcpClient) return oauthError(res, 404, 'invalid_client', 'Unknown client_id');
    const redirect = str(req.query.redirect_uri);
    return res.json({
      client_id: mcpClient.clientId,
      name: mcpClient.clientName,
      kind: 'mcp',
      redirect_uri_valid: redirect ? mcpClient.redirectUris.includes(redirect) : undefined,
    });
  }
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
/** Approving a new assistant (or more permissions) needs a fresh second factor when the user has one. */
async function mcpStepUpNeeded(req: AuthenticatedRequest, existing: McpGrant | null, scopes: string[]): Promise<boolean> {
  const widens = !existing || scopes.some((s) => !(existing.scopes || []).includes(s));
  if (!widens) return false;
  if (!(await isMfaEnabled(req.user!.id))) return false;
  return !hasRecentMfa(req);
}

/**
 * GET /api/oauth/consent — what the portal consent screen shows for a remote MCP client:
 * the registered name, the redirect host, and the permissions the signed-in person may grant.
 */
router.get('/oauth/consent', expressAuthenticate, requireHumanJwt, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const m = await validateMcpAuthorizeParams(req.query as Record<string, unknown>);
    if (!m.ok) return oauthError(res, m.status!, m.error!, m.description!);
    const existing = await findActiveGrant(authReq.user!.id, m.client!.id);
    const options = consentScopeOptions(m.requestedScopes!, authReq.user!.role);
    const checked = options.filter((o) => o.checked).map((o) => o.id);
    return res.json({
      client_id: m.client!.clientId,
      name: m.client!.clientName,
      kind: 'mcp',
      redirect_host: new URL(m.redirectUri!).origin,
      resource: m.resource,
      scopes: options,
      existing_scopes: existing ? existing.scopes : null,
      mfa_enabled: await isMfaEnabled(authReq.user!.id),
      step_up_max_age_sec: stepUpMaxAgeSec(),
      step_up_required: await mcpStepUpNeeded(authReq, existing, checked),
    });
  } catch {
    return oauthError(res, 500, 'server_error', 'Could not load the consent details');
  }
});

/** Remote MCP branch of POST /oauth/authorize: persist the grant, then issue a code bound to it. */
async function approveMcpAuthorization(req: AuthenticatedRequest, res: Response) {
  const body = (req.body || {}) as Record<string, unknown>;
  const m = await validateMcpAuthorizeParams(body);
  if (!m.ok) return oauthError(res, m.status!, m.error!, m.description!);
  const user = req.user!;

  const allowed = allowedScopesForRole(user.role);
  const checked = validateGrantedScopes(body.scopes, allowed);
  if (checked.ok === false) return oauthError(res, 400, 'invalid_scope', checked.error);

  const existing = await findActiveGrant(user.id, m.client!.id);
  if (await mcpStepUpNeeded(req, existing, checked.scopes)) {
    return res.status(401).json({
      error: 'step_up_required',
      maxAgeSec: stepUpMaxAgeSec(),
      message: 'Confirm with your authenticator app (POST /api/auth/mfa/step-up), then retry.',
    });
  }

  const { grant, created } = await upsertGrant({ userId: user.id, client: m.client!, scopes: checked.scopes, resource: m.resource! });
  await logAudit({
    userId: user.id,
    action: created ? 'mcp.grant.approve' : 'mcp.grant.update',
    targetType: 'mcp_grant',
    targetId: grant.id,
    metadata: { clientId: m.client!.clientId, clientName: m.client!.clientName, scopes: checked.scopes, redirectHost: new URL(m.redirectUri!).origin },
    ip: req.ip,
  });

  const portalSession = req.session;
  const now = Math.floor(Date.now() / 1000);
  let code: string;
  try {
    code = await oidcAuthCodes.issue({
      userId: user.id,
      clientId: m.client!.clientId,
      redirectUri: m.redirectUri!,
      scope: checked.scopes.join(' '),
      nonce: null,
      codeChallenge: str(body.code_challenge),
      authTime: typeof portalSession?.authTime === 'number' && portalSession.authTime <= now ? portalSession.authTime : now,
      amr: portalSession?.amr?.length ? portalSession.amr : undefined,
      mcp: { grantId: grant.id, resource: m.resource! },
    });
  } catch (err) {
    if (err instanceof StateStoreUnavailableError) {
      return oauthError(res, 503, 'temporarily_unavailable', 'Authorization is temporarily unavailable');
    }
    return oauthError(res, 500, 'server_error', 'Could not issue an authorization code');
  }
  return res.json({ redirect: appendParams(m.redirectUri!, { code, state: str(body.state) }) });
}

router.post('/oauth/authorize', expressAuthenticate, requireHumanJwt, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const body = (req.body || {}) as Record<string, unknown>;
  if (isMcpClientId(body.client_id)) {
    try {
      return await approveMcpAuthorization(authReq, res);
    } catch {
      return oauthError(res, 500, 'server_error', 'Could not complete the authorization');
    }
  }
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

/**
 * Token endpoint for public remote MCP clients (#193): authorization_code with PKCE, and
 * rotating refresh tokens. Access tokens are opaque, short-lived and bound to the /mcp resource.
 */
async function mcpToken(req: Request, res: Response, body: Record<string, unknown>) {
  if (!getMcpResourceUrl()) return oauthError(res, 503, 'temporarily_unavailable', MCP_UNCONFIGURED_MESSAGE);
  const client = await findMcpClient(body.client_id);
  if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
  const grantType = str(body.grant_type);
  const ds = await getDb();

  if (grantType === 'authorization_code') {
    let session: AuthCodeSession | null;
    try {
      session = await oidcAuthCodes.consume(body.code);
    } catch (err) {
      if (err instanceof StateStoreUnavailableError) {
        return oauthError(res, 503, 'temporarily_unavailable', 'Token exchange is temporarily unavailable');
      }
      throw err;
    }
    if (!session || !session.mcp) return oauthError(res, 400, 'invalid_grant', 'Invalid or expired authorization code');
    if (session.clientId !== client.clientId) return oauthError(res, 400, 'invalid_grant', 'Authorization code was issued to another client');
    if (str(body.redirect_uri) !== session.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match the authorization request');
    if (!session.codeChallenge || !verifyPkceS256(body.code_verifier, session.codeChallenge)) {
      return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
    }
    if (str(body.resource) && str(body.resource).replace(/\/+$/, '') !== session.mcp.resource) {
      return oauthError(res, 400, 'invalid_target', 'resource does not match the authorization request');
    }
    const grant = await ds.getRepository(McpGrant).findOne({ where: { id: session.mcp.grantId } });
    if (!grant || grant.revokedAt || grant.userId !== session.userId || grant.clientRef !== client.id) {
      return oauthError(res, 400, 'invalid_grant', 'The approval was withdrawn');
    }
    const user = await ds.getRepository(User).findOne({ where: { id: grant.userId } });
    if (!user || user.isActive === false) return oauthError(res, 400, 'invalid_grant', 'User is not active');
    const scopes = effectiveScopes(grant.scopes, user.role);
    const tokens = await issueTokens(grant, scopes, client.grantTypes.includes('refresh_token'));
    await logAudit({
      userId: user.id,
      action: 'mcp.token.issue',
      targetType: 'mcp_grant',
      targetId: grant.id,
      metadata: { clientId: client.clientId, clientName: client.clientName, scopes, grantType },
      ip: req.ip,
    });
    return res.json(tokens);
  }

  if (grantType === 'refresh_token') {
    if (!client.grantTypes.includes('refresh_token')) {
      return oauthError(res, 400, 'unauthorized_client', 'This client did not register for refresh tokens');
    }
    if (str(body.resource) && !isOurMcpResource(body.resource)) {
      return oauthError(res, 400, 'invalid_target', 'resource must be this server\'s MCP endpoint');
    }
    const outcome = await redeemRefreshToken(body.refresh_token, client);
    if (outcome.ok === false) {
      if (outcome.reason === 'reused') {
        await logAudit({
          action: 'mcp.token.reuse_detected',
          targetType: 'oauth_client',
          targetId: client.id,
          metadata: { clientId: client.clientId, clientName: client.clientName, outcome: 'grant revoked' },
          ip: req.ip,
        });
      }
      return oauthError(res, 400, 'invalid_grant', 'Invalid, expired or revoked refresh token');
    }
    const scopes = effectiveScopes(outcome.grant.scopes, outcome.user.role);
    const requested = parseScopeParam(str(body.scope));
    if (str(body.scope) && requested.some((s) => !scopes.includes(s))) {
      return oauthError(res, 400, 'invalid_scope', 'Requested scope exceeds the approval');
    }
    return res.json(await issueTokens(outcome.grant, scopes, true));
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
}

/**
 * POST /api/oauth/register — dynamic client registration (RFC 7591) for AI assistants.
 * Public clients only; the client can do nothing until a person approves it. Rate limited per
 * IP (server.ts), body capped, and the number of never-approved registrations is bounded.
 */
router.post('/oauth/register', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const size = Number(req.headers['content-length'] || 0);
    const raw = (req as any).rawBody as Buffer | undefined;
    if (size > REGISTRATION_MAX_BYTES || (raw && raw.length > REGISTRATION_MAX_BYTES)
      || (!raw && JSON.stringify(req.body || {}).length > REGISTRATION_MAX_BYTES)) {
      return res.status(413).json({ error: 'invalid_client_metadata', error_description: 'Registration request is too large' });
    }
    if (!getMcpResourceUrl()) {
      return res.status(503).json({ error: 'temporarily_unavailable', error_description: MCP_UNCONFIGURED_MESSAGE });
    }
    const v = validateRegistration(req.body);
    if (v.ok === false) return res.status(400).json(v.error);
    const ipHash = hashClientIp(req.ip);
    const slot = await prepareRegistrationSlot(ipHash);
    if (slot.ok === false) {
      return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many pending registrations from this address. Approve one, or try again later.' });
    }
    const ds = await getDb();
    const repo = ds.getRepository(OAuthClient);
    const saved = await repo.save(
      repo.create({
        clientId: newClientId(),
        clientName: v.value.clientName,
        redirectUris: v.value.redirectUris,
        grantTypes: v.value.grantTypes,
        softwareId: v.value.softwareId,
        softwareVersion: v.value.softwareVersion,
        registrationIpHash: ipHash,
        approvedAt: null,
        createdAt: new Date(),
      }),
    );
    await logAudit({
      action: 'mcp.client.register',
      targetType: 'oauth_client',
      targetId: saved.id,
      metadata: {
        clientId: saved.clientId,
        clientName: saved.clientName,
        redirectHosts: Array.from(new Set(saved.redirectUris.map((u) => new URL(u).origin))),
        evictedPending: slot.evicted || undefined,
      },
      ip: req.ip,
    });
    return res.status(201).json({
      client_id: saved.clientId,
      client_id_issued_at: Math.floor((saved.createdAt ? new Date(saved.createdAt).getTime() : Date.now()) / 1000),
      client_name: saved.clientName,
      redirect_uris: saved.redirectUris,
      grant_types: saved.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  } catch {
    return res.status(500).json({ error: 'server_error', error_description: 'Registration failed' });
  }
});

/**
 * POST /api/oauth/revoke — token revocation (RFC 7009) for remote MCP clients. Revoking a
 * refresh token ends the whole connection. Answers 200 for unknown tokens, as the RFC requires.
 */
router.post('/oauth/revoke', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const client = await findMcpClient(body.client_id);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
    const result = await revokeToken(body.token, client);
    if (result.revoked) {
      await logAudit({
        action: result.kind === 'refresh' ? 'mcp.grant.revoke' : 'mcp.token.revoke',
        targetType: 'mcp_grant',
        targetId: result.grantId,
        metadata: { clientId: client.clientId, clientName: client.clientName, by: 'client' },
        ip: req.ip,
      });
    }
    return res.status(200).json({});
  } catch {
    return oauthError(res, 503, 'temporarily_unavailable', 'Revocation is temporarily unavailable');
  }
});

router.post('/oauth/token', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const body = (req.body || {}) as Record<string, unknown>;

    // Public remote MCP client (no client secret, PKCE instead).
    if (isMcpClientId(body.client_id) && !req.headers.authorization && !str(body.client_secret)) {
      return await mcpToken(req, res, body);
    }

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
        groups: [user.role.toLowerCase().replace(/ /g, '_')],
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
      groups: [user.role.toLowerCase().replace(/ /g, '_')],
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
