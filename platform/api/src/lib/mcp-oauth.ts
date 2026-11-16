import * as crypto from 'crypto';
import { In, IsNull, LessThan } from 'typeorm';
import { getDb } from '../config/database';
import { OAuthClient } from '../entities/OAuthClient';
import { McpGrant } from '../entities/McpGrant';
import { McpToken, McpTokenKind } from '../entities/McpToken';
import { User } from '../entities/User';
import { effectiveScopes, isMcpScope } from './mcp-scopes';
import { getMcpResourceUrl } from './mcp-public-url';

/**
 * OAuth 2.1 pieces for the remote MCP endpoint (#193): dynamic client registration (RFC 7591),
 * grants, and opaque access/refresh tokens. Tokens are 256-bit random values with a readable
 * prefix; only their SHA-256 hash is stored. Access tokens are short-lived and bound to the MCP
 * resource; refresh tokens rotate on every use and a reused one revokes the grant.
 */

export const MCP_CLIENT_ID_PREFIX = 'mcp_';
export const ACCESS_TOKEN_PREFIX = 'cairn_at_';
export const REFRESH_TOKEN_PREFIX = 'cairn_rt_';

export function accessTokenTtlSec(): number {
  const n = Number(process.env.MCP_ACCESS_TOKEN_TTL_SEC);
  return Number.isFinite(n) && n >= 60 && n <= 86_400 ? Math.floor(n) : 3600;
}

export function refreshTokenTtlSec(): number {
  const n = Number(process.env.MCP_REFRESH_TOKEN_TTL_SEC);
  return Number.isFinite(n) && n >= 3600 && n <= 365 * 86_400 ? Math.floor(n) : 30 * 86_400;
}

/** Upper bound on registered clients nobody has approved yet; beyond it the oldest is evicted. */
export function maxUnapprovedClients(): number {
  const n = Number(process.env.MCP_MAX_UNAPPROVED_CLIENTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

/** Never-approved registrations one client address may hold at a time. */
export function maxPendingClientsPerIp(): number {
  const n = Number(process.env.MCP_MAX_PENDING_CLIENTS_PER_IP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

/**
 * Registrations nobody approved within this window are removed (on registration and by the
 * token-cleanup job). Connecting an assistant takes minutes, so an hour is plenty.
 */
export const UNAPPROVED_CLIENT_RETENTION_MS = 60 * 60 * 1000;

/** Hash of the registering client's address (only used to bound pending registrations per address). */
export function hashClientIp(ip: string | undefined): string | null {
  return ip ? crypto.createHash('sha256').update(`mcp-register:${ip}`).digest('hex') : null;
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
}

// ---------------------------------------------------------------------------
// Registration (RFC 7591)
// ---------------------------------------------------------------------------

/** Request body cap for POST /oauth/register. */
export const REGISTRATION_MAX_BYTES = 8 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const MAX_CLIENT_NAME = 80;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Redirect URIs must be absolute https URLs, or http on a loopback address (desktop apps,
 * RFC 8252). No fragments, no credentials. Matching later is exact string comparison.
 */
export function validateRedirectUri(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_REDIRECT_URI_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || raw.includes('#')) return null;
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') {
    return url.hostname ? raw : null;
  }
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? raw : null;
  }
  return null;
}

/**
 * Display name for the consent screen and the portal: printable text only (no control,
 * formatting or bidirectional-override characters), whitespace collapsed, length capped.
 * Angular escapes it on output; this keeps it from impersonating other UI text.
 */
export function sanitizeClientName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Unnamed assistant';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = Array.from(cleaned).slice(0, MAX_CLIENT_NAME).join('').trim();
  return capped || 'Unnamed assistant';
}

function shortText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return t ? t.slice(0, max) : null;
}

export interface RegistrationError {
  error: 'invalid_redirect_uri' | 'invalid_client_metadata';
  error_description: string;
}

export interface ValidRegistration {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  softwareId: string | null;
  softwareVersion: string | null;
}

export function validateRegistration(body: unknown): { ok: true; value: ValidRegistration } | { ok: false; error: RegistrationError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { error: 'invalid_client_metadata', error_description: 'Body must be a JSON object' } };
  }
  const b = body as Record<string, unknown>;

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array' } };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: { error: 'invalid_redirect_uri', error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed` } };
  }
  const redirectUris: string[] = [];
  for (const u of uris) {
    const ok = validateRedirectUri(u);
    if (!ok) {
      return {
        ok: false,
        error: { error: 'invalid_redirect_uri', error_description: 'Each redirect URI must be https, or http on 127.0.0.1, localhost or [::1], without a fragment' },
      };
    }
    if (!redirectUris.includes(ok)) redirectUris.push(ok);
  }

  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') {
    return { ok: false, error: { error: 'invalid_client_metadata', error_description: 'Only public clients are supported: token_endpoint_auth_method must be "none"' } };
  }

  let grantTypes = ['authorization_code', 'refresh_token'];
  if (b.grant_types !== undefined) {
    if (!Array.isArray(b.grant_types) || b.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token') || !b.grant_types.includes('authorization_code')) {
      return { ok: false, error: { error: 'invalid_client_metadata', error_description: 'grant_types may contain only authorization_code and refresh_token' } };
    }
    grantTypes = Array.from(new Set(b.grant_types as string[]));
  }

  if (b.response_types !== undefined) {
    if (!Array.isArray(b.response_types) || b.response_types.some((r) => r !== 'code')) {
      return { ok: false, error: { error: 'invalid_client_metadata', error_description: 'response_types may contain only code' } };
    }
  }

  return {
    ok: true,
    value: {
      clientName: sanitizeClientName(b.client_name),
      redirectUris,
      grantTypes,
      softwareId: shortText(b.software_id, 200),
      softwareVersion: shortText(b.software_version, 100),
    },
  };
}

export function newClientId(): string {
  return `${MCP_CLIENT_ID_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
}

export function isMcpClientId(id: unknown): id is string {
  return typeof id === 'string' && /^mcp_[a-f0-9]{32}$/.test(id);
}

export async function findMcpClient(clientId: unknown): Promise<OAuthClient | null> {
  if (!isMcpClientId(clientId)) return null;
  const ds = await getDb();
  return ds.getRepository(OAuthClient).findOne({ where: { clientId } });
}

export async function countUnapprovedClients(): Promise<number> {
  const ds = await getDb();
  return ds.getRepository(OAuthClient).count({ where: { approvedAt: IsNull() } });
}

/**
 * Make room for one more registration from `ipHash`:
 *  - drop never-approved registrations older than UNAPPROVED_CLIENT_RETENTION_MS;
 *  - refuse when this address already holds maxPendingClientsPerIp() pending registrations;
 *  - when the global cap is reached, evict the oldest pending registrations instead of refusing,
 *    so filling the table cannot block new assistants.
 * Approved clients are never touched.
 */
export async function prepareRegistrationSlot(ipHash: string | null, now = new Date()): Promise<{ ok: true; evicted: number } | { ok: false; reason: 'ip_limit' }> {
  const ds = await getDb();
  const repo = ds.getRepository(OAuthClient);
  await repo.delete({ approvedAt: IsNull(), createdAt: LessThan(new Date(now.getTime() - UNAPPROVED_CLIENT_RETENTION_MS)) });
  if (ipHash) {
    const mine = await repo.count({ where: { approvedAt: IsNull(), registrationIpHash: ipHash } });
    if (mine >= maxPendingClientsPerIp()) return { ok: false, reason: 'ip_limit' };
  }
  const pending = await repo.count({ where: { approvedAt: IsNull() } });
  const excess = pending - maxUnapprovedClients() + 1;
  if (excess <= 0) return { ok: true, evicted: 0 };
  const oldest = await repo.find({ where: { approvedAt: IsNull() }, order: { createdAt: 'ASC' }, take: excess });
  const ids = oldest.map((c) => c.id);
  if (ids.length) await repo.delete({ id: In(ids), approvedAt: IsNull() });
  return { ok: true, evicted: ids.length };
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export async function findActiveGrant(userId: string, clientRef: string): Promise<McpGrant | null> {
  const ds = await getDb();
  return ds.getRepository(McpGrant).findOne({ where: { userId, clientRef, revokedAt: IsNull() } });
}

/**
 * Create or update the user's grant for this client with exactly `scopes`.
 * Returns the grant and whether it is new (or widened), which is when step-up applies.
 */
export async function upsertGrant(params: { userId: string; client: OAuthClient; scopes: string[]; resource: string }): Promise<{ grant: McpGrant; created: boolean }> {
  const ds = await getDb();
  const repo = ds.getRepository(McpGrant);

  const updateExisting = async (existing: McpGrant) => {
    existing.scopes = params.scopes;
    existing.resource = params.resource;
    const saved = await repo.save(existing);
    // Re-consent replaces the earlier approval: refresh tokens issued under it stop working, so
    // only the session that just approved keeps access (with the new permissions).
    await ds.getRepository(McpToken).update({ grantId: existing.id, kind: 'refresh', revokedAt: IsNull() }, { revokedAt: new Date() });
    return { grant: saved, created: false };
  };

  const existing = await findActiveGrant(params.userId, params.client.id);
  if (existing) return updateExisting(existing);

  let grant: McpGrant;
  try {
    grant = await repo.save(
      repo.create({
        clientRef: params.client.id,
        userId: params.userId,
        scopes: params.scopes,
        resource: params.resource,
        lastUsedAt: null,
        revokedAt: null,
        revokedByUserId: null,
      }),
    );
  } catch (err) {
    // Two approvals at once: the partial unique index on active (user, client) grants lets only
    // one insert win; the other updates the winner.
    if (!isUniqueViolation(err)) throw err;
    const winner = await findActiveGrant(params.userId, params.client.id);
    if (!winner) throw err;
    return updateExisting(winner);
  }
  if (!params.client.approvedAt) {
    await ds.getRepository(OAuthClient).update({ id: params.client.id }, { approvedAt: new Date() });
  }
  return { grant, created: true };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

/** Revoke a grant and every token issued under it. Idempotent. */
export async function revokeGrant(grantId: string, byUserId: string | null): Promise<boolean> {
  const ds = await getDb();
  const now = new Date();
  const res = await ds.getRepository(McpGrant).update({ id: grantId, revokedAt: IsNull() }, { revokedAt: now, revokedByUserId: byUserId });
  await ds.getRepository(McpToken).update({ grantId, revokedAt: IsNull() }, { revokedAt: now });
  return (res?.affected ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

async function storeToken(grantId: string, kind: McpTokenKind, ttlSec: number): Promise<string> {
  const raw = randomToken(kind === 'access' ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX);
  const ds = await getDb();
  const repo = ds.getRepository(McpToken);
  await repo.save(
    repo.create({
      grantId,
      kind,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + ttlSec * 1000),
      usedAt: null,
      revokedAt: null,
    }),
  );
  return raw;
}

export async function issueTokens(grant: McpGrant, scopes: string[], withRefresh: boolean): Promise<IssuedTokens> {
  const ttl = accessTokenTtlSec();
  const access = await storeToken(grant.id, 'access', ttl);
  const out: IssuedTokens = { access_token: access, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') };
  if (withRefresh) out.refresh_token = await storeToken(grant.id, 'refresh', refreshTokenTtlSec());
  return out;
}

export type RefreshOutcome =
  | { ok: true; grant: McpGrant; client: OAuthClient; user: User }
  | { ok: false; reason: 'invalid' | 'reused' | 'client_mismatch' | 'resource_mismatch' };

/**
 * Redeem a refresh token once. A token that was already used revokes the whole grant
 * (stolen-token detection, OAuth 2.1 section 4.3.1).
 */
export async function redeemRefreshToken(raw: unknown, client: OAuthClient): Promise<RefreshOutcome> {
  if (typeof raw !== 'string' || !raw.startsWith(REFRESH_TOKEN_PREFIX) || raw.length > 200) return { ok: false, reason: 'invalid' };
  const ds = await getDb();
  const tokens = ds.getRepository(McpToken);
  const row = await tokens.findOne({ where: { tokenHash: hashToken(raw) } });
  if (!row || row.kind !== 'refresh') return { ok: false, reason: 'invalid' };
  const grant = await ds.getRepository(McpGrant).findOne({ where: { id: row.grantId } });
  if (!grant || grant.revokedAt) return { ok: false, reason: 'invalid' };
  if (grant.clientRef !== client.id) return { ok: false, reason: 'client_mismatch' };
  if (row.usedAt) {
    await revokeGrant(grant.id, null);
    return { ok: false, reason: 'reused' };
  }
  if (row.revokedAt || row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'invalid' };
  // Single use across replicas: only one request can flip used_at from NULL.
  const claim = await tokens.update({ id: row.id, usedAt: IsNull() }, { usedAt: new Date() });
  if (!claim || claim.affected !== 1) {
    await revokeGrant(grant.id, null);
    return { ok: false, reason: 'reused' };
  }
  const user = await ds.getRepository(User).findOne({ where: { id: grant.userId } });
  if (!user || user.isActive === false) return { ok: false, reason: 'invalid' };
  if (grant.resource !== getMcpResourceUrl()) return { ok: false, reason: 'resource_mismatch' };
  return { ok: true, grant, client, user };
}

/** Revoke one token (RFC 7009). Revoking a refresh token revokes its whole grant. */
export async function revokeToken(raw: unknown, client: OAuthClient): Promise<{ revoked: boolean; grantId?: string; kind?: McpTokenKind }> {
  if (typeof raw !== 'string' || raw.length > 200) return { revoked: false };
  const ds = await getDb();
  const row = await ds.getRepository(McpToken).findOne({ where: { tokenHash: hashToken(raw) } });
  if (!row) return { revoked: false };
  const grant = await ds.getRepository(McpGrant).findOne({ where: { id: row.grantId } });
  if (!grant || grant.clientRef !== client.id) return { revoked: false };
  if (row.kind === 'refresh') {
    await revokeGrant(grant.id, grant.userId);
  } else {
    await ds.getRepository(McpToken).update({ id: row.id, revokedAt: IsNull() }, { revokedAt: new Date() });
  }
  return { revoked: true, grantId: grant.id, kind: row.kind };
}

export interface McpPrincipal {
  grantId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  user: { id: string; role: User['role']; roleId: string | null; name: string; email: string };
}

/**
 * Validate a remote MCP access token: known hash, access kind, not expired or revoked, grant
 * active and bound to this server's MCP resource, client still registered, user still active.
 * Scopes are re-capped by the user's current role.
 */
export async function verifyAccessToken(raw: unknown): Promise<McpPrincipal | null> {
  if (typeof raw !== 'string' || !raw.startsWith(ACCESS_TOKEN_PREFIX) || raw.length > 200) return null;
  const ds = await getDb();
  const row = await ds.getRepository(McpToken).findOne({ where: { tokenHash: hashToken(raw) } });
  if (!row || row.kind !== 'access' || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
  const grant = await ds.getRepository(McpGrant).findOne({ where: { id: row.grantId } });
  const resource = getMcpResourceUrl();
  if (!grant || grant.revokedAt || !resource || grant.resource !== resource) return null;
  const client = await ds.getRepository(OAuthClient).findOne({ where: { id: grant.clientRef } });
  if (!client) return null;
  const user = await ds.getRepository(User).findOne({ where: { id: grant.userId } });
  if (!user || user.isActive === false) return null;
  return {
    grantId: grant.id,
    clientId: client.clientId,
    clientName: client.clientName,
    scopes: effectiveScopes(grant.scopes, user.role),
    user: { id: user.id, role: user.role, roleId: user.roleId, name: user.name, email: user.email },
  };
}

/** Record use at most once a minute per grant (one conditional UPDATE, no local state). */
export async function touchGrant(grantId: string): Promise<void> {
  try {
    const ds = await getDb();
    await ds
      .getRepository(McpGrant)
      .createQueryBuilder()
      .update(McpGrant)
      .set({ lastUsedAt: () => 'now()' })
      .where('id = :id', { id: grantId })
      .andWhere(`(last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`)
      .execute();
  } catch {
    /* best effort */
  }
}

/** Requested scopes from the consent screen: known, deduplicated, within the role ceiling. */
export function validateGrantedScopes(raw: unknown, allowed: string[]): { ok: true; scopes: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Pick at least one permission' };
  const out: string[] = [];
  for (const s of raw) {
    if (!isMcpScope(s)) return { ok: false, error: `Unknown permission: ${String(s).slice(0, 40)}` };
    if (!allowed.includes(s)) return { ok: false, error: `Your role cannot grant ${s}` };
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, scopes: out };
}
