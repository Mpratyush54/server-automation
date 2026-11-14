/**
 * Remote MCP endpoint + OAuth for AI assistants (#193): metadata, dynamic client registration,
 * PKCE, consent scope ceiling, step-up, token issue/refresh rotation/revocation, 401 challenge,
 * agent-token bearer fallback, audit, and the portal's connected-assistants API.
 * Repositories are in memory; MCP tool calls go through the real loopback API listener.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} makeApiClient() { return {}; } },
  CustomObjectsApi: class {},
}));
jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes: jest.fn().mockResolvedValue([]),
  getK8sNamespaces: jest.fn().mockResolvedValue([]),
  getK8sPods: jest.fn().mockResolvedValue([]),
  getPodLogs: jest.fn().mockResolvedValue(''),
  deletePod: jest.fn().mockResolvedValue(true),
  updateArgoCDApp: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../src/lib/lokilog', () => ({ forwardToLoki: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn().mockResolvedValue(true) }));

import { MemoryRepo } from '../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name),
  })),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import apiRouter from '../../src/routes/api';
import { buildMcpRouter } from '../../src/routes/mcp';
import { hashToken, hashClientIp } from '../../src/lib/mcp-oauth';
import { buildLoopbackApp, closeLoopbackServer } from '../../src/lib/mcp-loopback';
import { MCP_INTERNAL_HEADER, mcpInternalSecret } from '../../src/lib/mcp-internal';

const JWT_SECRET = (process.env.JWT_SECRET = 'mcp-remote-test-jwt-secret-0123456789abcdef');
process.env.DOMAIN = 'cairn.example.test';
delete process.env.OIDC_ISSUER;
delete process.env.MCP_PUBLIC_URL;

const BASE = 'https://cairn.example.test';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const ADMIN = { id: '00000000-0000-4000-8000-000000000001', email: 'admin@example.test', name: 'Admin', role: 'admin', roleId: null, isActive: true };
const DEV = { id: '00000000-0000-4000-8000-000000000002', email: 'dev@example.test', name: 'Dev', role: 'developer', roleId: null, isActive: true };
const DEV2 = { id: '00000000-0000-4000-8000-000000000003', email: 'dev2@example.test', name: 'Dev Two', role: 'developer', roleId: null, isActive: true };
const OPS = { id: '00000000-0000-4000-8000-000000000004', email: 'ops@example.test', name: 'Ops', role: 'devops', roleId: null, isActive: true };

const RAW_AGENT = 'plat_agent_00112233445566778899aabbccddeeff';

function session(user: { id: string; email: string; name: string; role: string }, extra: Record<string, unknown> = {}) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, amr: ['pwd'], auth_time: Math.floor(Date.now() / 1000), ...extra }, JWT_SECRET, { expiresIn: '1h' });
}
const mfaSession = (user: typeof ADMIN) => session(user, { amr: ['pwd', 'otp', 'mfa'] });

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let app: express.Express;

function audits(action: string) {
  return mockRepo('AuditLog').rows.filter((r) => r.action === action);
}

async function register(body: Record<string, unknown> = {}) {
  return request(app).post('/api/oauth/register').send({ client_name: 'Claude', redirect_uris: [REDIRECT], ...body });
}

/** Register, approve as `user` with `scopes`, exchange the code: returns tokens + ids. */
async function connect(user: typeof ADMIN, scopes: string[], jwtToken = session(user)) {
  const reg = await register();
  expect(reg.status).toBe(201);
  const clientId = reg.body.client_id;
  const { verifier, challenge } = pkce();
  const approve = await request(app)
    .post('/api/oauth/authorize')
    .set('Authorization', `Bearer ${jwtToken}`)
    .send({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, state: 's1', scopes });
  expect(approve.status).toBe(200);
  const code = new URL(approve.body.redirect).searchParams.get('code')!;
  const token = await request(app)
    .post('/api/oauth/token')
    .type('form')
    .send({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE });
  expect(token.status).toBe(200);
  return { clientId, ...token.body } as { clientId: string; access_token: string; refresh_token: string; expires_in: number; scope: string };
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function mcp(token: string | null, body: unknown) {
  const r = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token) r.set('Authorization', `Bearer ${token}`);
  return r.send(JSON.stringify(body));
}

afterAll(async () => {
  await closeLoopbackServer();
});

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/api', apiRouter);
  app.use(buildMcpRouter());
});

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockRepo('User').rows.push({ ...ADMIN }, { ...DEV }, { ...DEV2 }, { ...OPS });
  mockRepo('AgentToken').rows.push({
    id: 'a0000000-0000-4000-8000-000000000001',
    name: 'cursor-laptop',
    tokenPrefix: RAW_AGENT.slice(0, 20),
    tokenHash: bcrypt.hashSync(RAW_AGENT, 4),
    scopes: ['projects:read', 'logs:read'],
    isActive: true,
    revokedAt: null,
    expiresAt: null,
  });
});

describe('metadata', () => {
  it('serves RFC 9728 protected resource metadata at both locations', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      expect(r.body.resource).toBe(RESOURCE);
      expect(r.body.authorization_servers).toEqual([`${BASE}/api/oauth`]);
      expect(r.body.scopes_supported).toEqual(expect.arrayContaining(['projects:read', 'commands:execute']));
      expect(r.body.bearer_methods_supported).toEqual(['header']);
    }
  });

  it('serves RFC 8414 authorization server metadata (root, path-inserted and issuer-relative)', async () => {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/api/oauth']) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      expect(r.body.issuer).toBe(`${BASE}/api/oauth`);
      expect(r.body.registration_endpoint).toBe(`${BASE}/api/oauth/register`);
      expect(r.body.revocation_endpoint).toBe(`${BASE}/api/oauth/revoke`);
      expect(r.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(r.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(r.body.token_endpoint_auth_methods_supported).toContain('none');
    }
    const rel = await request(app).get('/api/oauth/.well-known/oauth-authorization-server');
    expect(rel.status).toBe(200);
    expect(rel.body.issuer).toBe(`${BASE}/api/oauth`);
  });

  it('refuses to work when no public address is configured', async () => {
    const saved = process.env.DOMAIN;
    delete process.env.DOMAIN;
    try {
      expect((await request(app).get('/.well-known/oauth-protected-resource')).status).toBe(503);
      expect((await mcp(null, rpc('initialize'))).status).toBe(503);
      expect((await register()).status).toBe(503);
    } finally {
      process.env.DOMAIN = saved;
    }
  });
});

describe('401 challenge on /mcp', () => {
  it('without credentials: 401 with resource_metadata', async () => {
    const r = await mcp(null, rpc('initialize'));
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('with a bad token or a portal session JWT: 401 invalid_token', async () => {
    for (const token of ['cairn_at_nope', session(ADMIN), 'plat_agent_ffffffffffffffffffffffff']) {
      const r = await mcp(token, rpc('tools/list'));
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toContain('error="invalid_token"');
      expect(r.headers['www-authenticate']).toContain('resource_metadata=');
    }
  });

  it('GET /mcp is 405 for an authenticated caller (stateless, no SSE stream)', async () => {
    const r = await request(app).get('/mcp').set('Authorization', `Bearer ${RAW_AGENT}`);
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('POST');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and audits it', async () => {
    const r = await register({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(r.status).toBe(201);
    expect(r.body.client_id).toMatch(/^mcp_[a-f0-9]{32}$/);
    expect(r.body.token_endpoint_auth_method).toBe('none');
    expect(r.body.redirect_uris).toEqual([REDIRECT]);
    expect(r.body).not.toHaveProperty('client_secret');
    expect(audits('mcp.client.register')).toHaveLength(1);
  });

  it('accepts loopback http redirects for desktop apps', async () => {
    for (const uri of ['http://127.0.0.1:33418/callback', 'http://localhost:6274/oauth/callback', 'http://[::1]:8080/cb']) {
      const r = await register({ redirect_uris: [uri] });
      expect(r.status).toBe(201);
    }
  });

  it.each([
    ['http on a public host', { redirect_uris: ['http://evil.example/cb'] }],
    ['a fragment', { redirect_uris: ['https://app.example/cb#x'] }],
    ['a non-http scheme', { redirect_uris: ['javascript:alert(1)'] }],
    ['credentials in the URI', { redirect_uris: ['https://user:pw@app.example/cb'] }],
    ['no redirect URIs', { redirect_uris: [] }],
    ['too many redirect URIs', { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://app.example/cb${i}`) }],
    ['a confidential client', { token_endpoint_auth_method: 'client_secret_basic' }],
    ['an unsupported grant type', { grant_types: ['client_credentials'] }],
    ['an implicit response type', { response_types: ['token'] }],
  ])('rejects %s', async (_label, body) => {
    const r = await register(body);
    expect(r.status).toBe(400);
    expect(['invalid_redirect_uri', 'invalid_client_metadata']).toContain(r.body.error);
  });

  it('rejects oversized bodies', async () => {
    const r = await register({ client_name: 'x'.repeat(20_000) });
    expect(r.status).toBe(413);
  });

  it('limits pending registrations per address (429), without touching other addresses', async () => {
    process.env.MCP_MAX_PENDING_CLIENTS_PER_IP = '3';
    try {
      for (let i = 0; i < 3; i++) expect((await register()).status).toBe(201);
      const r = await register();
      expect(r.status).toBe(429);
      expect(r.body.error).toBe('too_many_requests');
      // Approving one frees a slot for this address.
      mockRepo('OAuthClient').rows[0].approvedAt = new Date();
      expect((await register()).status).toBe(201);
    } finally {
      delete process.env.MCP_MAX_PENDING_CLIENTS_PER_IP;
    }
  });

  it('at the global cap, evicts the oldest pending registration instead of refusing', async () => {
    process.env.MCP_MAX_UNAPPROVED_CLIENTS = '3';
    try {
      const repo = mockRepo('OAuthClient');
      const now = Date.now();
      repo.rows.push(
        { id: 'c-approved', clientId: 'mcp_' + 'a'.repeat(32), clientName: 'Kept', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: new Date(now - 5000), createdAt: new Date(now - 9000), registrationIpHash: 'x' },
        { id: 'c-old', clientId: 'mcp_' + 'b'.repeat(32), clientName: 'Old', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: null, createdAt: new Date(now - 3000), registrationIpHash: 'other-1' },
        { id: 'c-mid', clientId: 'mcp_' + 'c'.repeat(32), clientName: 'Mid', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: null, createdAt: new Date(now - 2000), registrationIpHash: 'other-2' },
        { id: 'c-new', clientId: 'mcp_' + 'd'.repeat(32), clientName: 'New', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: null, createdAt: new Date(now - 1000), registrationIpHash: 'other-3' },
      );
      const r = await register();
      expect(r.status).toBe(201);
      const ids = repo.rows.map((c) => c.id);
      expect(ids).not.toContain('c-old');
      expect(ids).toEqual(expect.arrayContaining(['c-approved', 'c-mid', 'c-new']));
      expect(repo.rows.filter((c) => !c.approvedAt)).toHaveLength(3);
    } finally {
      delete process.env.MCP_MAX_UNAPPROVED_CLIENTS;
    }
  });

  it('drops never-approved registrations after an hour, keeps approved ones', async () => {
    const repo = mockRepo('OAuthClient');
    const old = new Date(Date.now() - 61 * 60 * 1000);
    repo.rows.push(
      { id: 'stale', clientId: 'mcp_' + 'e'.repeat(32), clientName: 'Stale', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: null, createdAt: old, registrationIpHash: hashClientIp('::ffff:127.0.0.1') },
      { id: 'approved-old', clientId: 'mcp_' + 'f'.repeat(32), clientName: 'Approved', redirectUris: [REDIRECT], grantTypes: ['authorization_code'], approvedAt: old, createdAt: old, registrationIpHash: null },
    );
    expect((await register()).status).toBe(201);
    expect(repo.rows.map((c) => c.id)).not.toContain('stale');
    expect(repo.rows.map((c) => c.id)).toContain('approved-old');
    expect(repo.rows.find((c) => c.clientName === 'Claude').registrationIpHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sanitises the display name', async () => {
    const r = await register({ client_name: '  Claude‮\u0000 <b>Desktop</b>\n\n  ' + 'y'.repeat(200) });
    expect(r.status).toBe(201);
    expect(r.body.client_name).not.toMatch(/[\u0000-\u001f‮<>]/);
    expect(r.body.client_name.startsWith('Claude bDesktop/b')).toBe(true);
    expect(Array.from(r.body.client_name).length).toBeLessThanOrEqual(80);
  });
});

describe('authorization request', () => {
  let clientId: string;
  beforeEach(async () => {
    clientId = (await register()).body.client_id;
  });

  const authorize = (q: Record<string, string>) => request(app).get('/api/oauth/authorize').query({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 'st', ...q });

  /** Errors for self-registered clients are shown on our own page, never sent to the client. */
  function expectOwnErrorPage(r: request.Response, error: string) {
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.origin).toBe(BASE);
    expect(loc.pathname).toBe('/oauth/authorize');
    expect(loc.searchParams.get('error')).toBe(error);
    expect(loc.searchParams.get('client_id')).toBeNull();
    expect(loc.searchParams.get('state')).toBeNull();
    expect(r.headers.location).not.toContain('claude.ai');
  }

  it('requires PKCE S256', async () => {
    expectOwnErrorPage(await authorize({}), 'invalid_request');
    expectOwnErrorPage(await authorize({ code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' }), 'invalid_request');
  });

  it('rejects a resource that is not this MCP endpoint', async () => {
    const r = await authorize({ code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: 'https://other.example/mcp' });
    expectOwnErrorPage(r, 'invalid_target');
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const r = await authorize({ redirect_uri: 'https://evil.example/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expectOwnErrorPage(r, 'invalid_request');
    expect(r.headers.location).not.toContain('evil.example');
  });

  it('unknown clients also get our error page', async () => {
    const r = await request(app).get('/api/oauth/authorize').query({ client_id: 'mcp_' + '0'.repeat(32), redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expectOwnErrorPage(r, 'invalid_client');
  });

  it('static SSO clients keep sending errors back to their registered redirect', async () => {
    process.env.OIDC_CLIENT_SECRET_ARGOCD = 'argocd-test-secret-0123456789';
    const { resetOidcClientCache } = await import('../../src/lib/oidc-clients');
    resetOidcClientCache();
    const r = await request(app).get('/api/oauth/authorize').query({ client_id: 'argocd', redirect_uri: `${BASE}/argocd/auth/callback`, response_type: 'token', state: 'st' });
    expect(r.status).toBe(302);
    expect(r.headers.location.startsWith(`${BASE}/argocd/auth/callback?`)).toBe(true);
    expect(new URL(r.headers.location).searchParams.get('error')).toBe('unsupported_response_type');
  });

  it('hands a valid request to the portal consent screen with the resource', async () => {
    const r = await authorize({ code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: RESOURCE, scope: 'projects:read bogus' });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.pathname).toBe('/oauth/authorize');
    expect(loc.searchParams.get('resource')).toBe(RESOURCE);
    expect(loc.searchParams.get('scope')).toBe('projects:read');
  });
});

describe('consent and scope ceiling', () => {
  it('consent info marks scopes above the role as not allowed and ticks read-only defaults', async () => {
    const clientId = (await register()).body.client_id;
    const r = await request(app)
      .get('/api/oauth/consent')
      .set('Authorization', `Bearer ${session(DEV)}`)
      .query({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Claude');
    expect(r.body.redirect_host).toBe('https://claude.ai');
    const byId = Object.fromEntries(r.body.scopes.map((s: any) => [s.id, s]));
    expect(byId['projects:read']).toMatchObject({ allowed: true, checked: true });
    expect(byId['commands:execute']).toMatchObject({ allowed: false, checked: false });
    expect(byId['cluster:read']).toMatchObject({ allowed: false, checked: false });
    expect(r.body.step_up_required).toBe(false);
  });

  it('refuses scopes above the approving user\'s role', async () => {
    const clientId = (await register()).body.client_id;
    const r = await request(app)
      .post('/api/oauth/authorize')
      .set('Authorization', `Bearer ${session(DEV)}`)
      .send({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', scopes: ['projects:read', 'commands:execute'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_scope');
    expect(mockRepo('McpGrant').rows).toHaveLength(0);
  });

  it('requires a recent second factor for a new client when the user has 2FA', async () => {
    mockRepo('UserMfa').rows.push({ id: 'm1', userId: ADMIN.id, enabledAt: new Date(), secretEncrypted: 'x', lastUsedStep: 0 });
    const clientId = (await register()).body.client_id;
    const body = { client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', scopes: ['projects:read'] };
    const denied = await request(app).post('/api/oauth/authorize').set('Authorization', `Bearer ${session(ADMIN)}`).send(body);
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe('step_up_required');
    const ok = await request(app).post('/api/oauth/authorize').set('Authorization', `Bearer ${mfaSession(ADMIN)}`).send(body);
    expect(ok.status).toBe(200);
    // Same client, same permissions again: no new step-up.
    const again = await request(app).post('/api/oauth/authorize').set('Authorization', `Bearer ${session(ADMIN)}`).send({ ...body, code_challenge: pkce().challenge });
    expect(again.status).toBe(200);
    // More permissions: step-up again.
    const wider = await request(app).post('/api/oauth/authorize').set('Authorization', `Bearer ${session(ADMIN)}`).send({ ...body, scopes: ['projects:read', 'commands:execute'] });
    expect(wider.status).toBe(401);
    expect(audits('mcp.grant.approve')).toHaveLength(1);
  });
});

describe('tokens', () => {
  it('issues hashed, prefixed tokens and enforces PKCE and single-use codes', async () => {
    const clientId = (await register()).body.client_id;
    const { verifier, challenge } = pkce();
    const approve = await request(app)
      .post('/api/oauth/authorize')
      .set('Authorization', `Bearer ${session(DEV)}`)
      .send({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: RESOURCE, scopes: ['projects:read'] });
    const code = new URL(approve.body.redirect).searchParams.get('code')!;

    const wrong = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    // The failed attempt consumed the code (single use).
    const reuse = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(reuse.status).toBe(400);

    const t = await connect(DEV, ['projects:read', 'logs:read']);
    expect(t.access_token).toMatch(/^cairn_at_/);
    expect(t.refresh_token).toMatch(/^cairn_rt_/);
    expect(t.expires_in).toBe(3600);
    expect(t.scope).toBe('projects:read logs:read');
    const stored = JSON.stringify(mockRepo('McpToken').rows);
    expect(stored).not.toContain(t.access_token);
    expect(stored).not.toContain(t.refresh_token);
    expect(mockRepo('McpToken').rows.map((r) => r.tokenHash)).toContain(hashToken(t.access_token));
  });

  it('rotates refresh tokens and revokes the grant when an old one is reused', async () => {
    const t = await connect(DEV, ['projects:read']);
    const first = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    expect(first.status).toBe(200);
    expect(first.body.refresh_token).not.toBe(t.refresh_token);
    expect((await mcp(first.body.access_token, rpc('tools/list'))).status).toBe(200);

    const replay = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    expect(replay.status).toBe(400);
    expect(audits('mcp.token.reuse_detected')).toHaveLength(1);
    // Reuse revoked everything issued under the grant.
    expect((await mcp(first.body.access_token, rpc('tools/list'))).status).toBe(401);
    const next = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: first.body.refresh_token });
    expect(next.status).toBe(400);
  });

  it('re-consent revokes refresh tokens issued under the earlier approval', async () => {
    const t = await connect(DEV, ['projects:read']);
    const { verifier, challenge } = pkce();
    const again = await request(app)
      .post('/api/oauth/authorize')
      .set('Authorization', `Bearer ${session(DEV)}`)
      .send({ client_id: t.clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scopes: ['projects:read', 'logs:read'] });
    expect(again.status).toBe(200);
    expect(mockRepo('McpGrant').rows).toHaveLength(1);
    const old = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh_token });
    expect(old.status).toBe(400);
    const code = new URL(again.body.redirect).searchParams.get('code')!;
    const fresh = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'authorization_code', client_id: t.clientId, code, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(fresh.status).toBe(200);
    expect(fresh.body.scope).toBe('projects:read logs:read');
  });

  it('two approvals racing for the same client end in one active grant', async () => {
    const clientId = (await register()).body.client_id;
    const grants = mockRepo('McpGrant');
    const realSave = grants.save.bind(grants);
    let raced = false;
    // The first insert loses to a concurrent approval that committed first (unique index).
    grants.save = (async (entity: any) => {
      if (!raced && !entity.id) {
        raced = true;
        await realSave({ ...entity, scopes: ['logs:read'] });
        const err: any = new Error('duplicate key value violates unique constraint "mcp_grants_active_user_client"');
        err.code = '23505';
        throw err;
      }
      return realSave(entity);
    }) as any;
    try {
      const r = await request(app)
        .post('/api/oauth/authorize')
        .set('Authorization', `Bearer ${session(DEV)}`)
        .send({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', scopes: ['projects:read'] });
      expect(r.status).toBe(200);
      expect(grants.rows.filter((g) => !g.revokedAt)).toHaveLength(1);
      expect(grants.rows[0].scopes).toEqual(['projects:read']);
    } finally {
      grants.save = realSave as any;
    }
  });

  it('refuses a refresh token presented by another client', async () => {
    const t = await connect(DEV, ['projects:read']);
    const other = (await register()).body.client_id;
    const r = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: other, refresh_token: t.refresh_token });
    expect(r.status).toBe(400);
  });

  it('revocation (RFC 7009) of the refresh token ends access immediately', async () => {
    const t = await connect(DEV, ['projects:read']);
    expect((await mcp(t.access_token, rpc('tools/list'))).status).toBe(200);
    const r = await request(app).post('/api/oauth/revoke').type('form').send({ client_id: t.clientId, token: t.refresh_token });
    expect(r.status).toBe(200);
    expect((await mcp(t.access_token, rpc('tools/list'))).status).toBe(401);
    expect(audits('mcp.grant.revoke')).toHaveLength(1);
    // Unknown tokens still answer 200.
    expect((await request(app).post('/api/oauth/revoke').type('form').send({ client_id: t.clientId, token: 'nope' })).status).toBe(200);
  });

  it('access tokens are bound to /mcp: the public API refuses them', async () => {
    const t = await connect(DEV, ['projects:read']);
    const r = await request(app).get('/api/agent-tokens/me').set('Authorization', `Bearer ${t.access_token}`);
    expect(r.status).toBe(401);
  });

  it('expired access tokens are refused', async () => {
    const t = await connect(DEV, ['projects:read']);
    const row = mockRepo('McpToken').rows.find((r) => r.tokenHash === hashToken(t.access_token))!;
    row.expiresAt = new Date(Date.now() - 1000);
    expect((await mcp(t.access_token, rpc('tools/list'))).status).toBe(401);
  });
});

describe('MCP over Streamable HTTP', () => {
  function toolText(res: request.Response) {
    return JSON.parse(res.body.result.content[0].text);
  }

  it('initialize, list tools and call a tool as the connected assistant; audits connect and tool calls', async () => {
    const t = await connect(DEV, ['projects:read', 'logs:read']);
    const init = await mcp(t.access_token, rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1.0' } }));
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('cairn');
    expect(init.headers['mcp-session-id']).toBeUndefined();
    expect(audits('mcp.connect')).toHaveLength(1);
    expect(audits('mcp.connect')[0]).toMatchObject({ userId: DEV.id, targetType: 'mcp_grant' });

    const list = await mcp(t.access_token, rpc('tools/list', {}, 2));
    expect(list.status).toBe(200);
    const names = list.body.result.tools.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['platform_whoami', 'platform_list_projects', 'platform_search_logs', 'platform_run_command']));
    for (const humanOnly of ['platform_login', 'platform_approve_command', 'platform_deploy']) expect(names).not.toContain(humanOnly);

    const who = await mcp(t.access_token, rpc('tools/call', { name: 'platform_whoami', arguments: {} }, 3));
    expect(who.status).toBe(200);
    const identity = toolText(who);
    expect(identity).toMatchObject({ type: 'mcp_connection', name: 'Claude', scopes: ['projects:read', 'logs:read'] });
    expect(identity.actingFor).toMatchObject({ id: DEV.id, role: 'developer' });
    expect(JSON.stringify(who.body)).not.toContain(t.access_token);

    const call = audits('mcp.tool_call');
    expect(call).toHaveLength(1);
    expect(call[0].metadata).toMatchObject({ tool: 'platform_whoami', ok: true, clientName: 'Claude' });
  });

  it('keeps the scope ceiling: a developer\'s assistant cannot read the audit log or the cluster', async () => {
    const t = await connect(DEV, ['projects:read']);
    for (const name of ['platform_audit_logs', 'platform_list_nodes']) {
      const r = await mcp(t.access_token, rpc('tools/call', { name, arguments: {} }));
      expect(r.status).toBe(200);
      expect(r.body.result.isError).toBe(true);
      expect(JSON.parse(r.body.result.content[0].text).status).toBe(403);
    }
  });

  it('narrows an existing connection when the person\'s role is lowered', async () => {
    const t = await connect(OPS, ['projects:read', 'cluster:read', 'commands:execute'], mfaSession(OPS));
    mockRepo('User').rows.find((u) => u.id === OPS.id)!.role = 'developer';
    const who = await mcp(t.access_token, rpc('tools/call', { name: 'platform_whoami', arguments: {} }));
    expect(toolText(who).scopes).toEqual(['projects:read']);
  });

  it('accepts an agent token as a bearer (clients without OAuth)', async () => {
    const list = await mcp(RAW_AGENT, rpc('tools/list'));
    expect(list.status).toBe(200);
    const who = await mcp(RAW_AGENT, rpc('tools/call', { name: 'platform_whoami', arguments: {} }));
    expect(toolText(who)).toMatchObject({ type: 'agent_token', name: 'cursor-laptop' });
    expect(audits('mcp.tool_call')[0]).toMatchObject({ targetType: 'agent_token' });
  });

  it('risky commands still need a person: validation opens an approval owned by the grant', async () => {
    process.env.AGENT_COMMAND_DRY_RUN = '1';
    const t = await connect(OPS, ['commands:validate', 'commands:execute'], mfaSession(OPS));
    const r = await mcp(t.access_token, rpc('tools/call', { name: 'platform_run_command', arguments: { command: 'kubectl delete pod web-1 -n demo' } }));
    expect(r.status).toBe(200);
    const out = toolText(r);
    expect(out.phase).toBe('validation');
    expect(out.validation.requiresHumanApproval).toBe(true);
    const approval = mockRepo('AgentCommandApproval').rows[0];
    expect(approval.id).toBe(out.validation.approvalId);
    expect(approval.requestedByMcpGrantId).toBeTruthy();
    expect(approval.requestedByAgentTokenId).toBeNull();
    expect(approval.metadata).toMatchObject({ assistantName: 'Claude', actingFor: { id: OPS.id, name: OPS.name } });
    const exec = await mcp(t.access_token, rpc('tools/call', { name: 'platform_run_command', arguments: { command: 'kubectl delete pod web-1 -n demo', confirm: true, reason: 'test' } }));
    expect(exec.body.result.isError).toBe(true);
    expect(JSON.parse(exec.body.result.content[0].text).status).toBe(403);
    // After a person approves it, only this connection can use the approval.
    await mockRepo('AgentCommandApproval').update({ id: approval.id }, { status: 'approved', approvalExpiresAt: new Date(Date.now() + 60_000) });
    const other = await connect(OPS, ['commands:validate', 'commands:execute'], mfaSession(OPS));
    const stolen = await mcp(other.access_token, rpc('tools/call', { name: 'platform_run_command', arguments: { command: 'kubectl delete pod web-1 -n demo', confirm: true, reason: 'test', approvalId: approval.id } }));
    expect(JSON.parse(stolen.body.result.content[0].text).status).toBe(403);
    const ran = await mcp(t.access_token, rpc('tools/call', { name: 'platform_run_command', arguments: { command: 'kubectl delete pod web-1 -n demo', confirm: true, reason: 'test', approvalId: approval.id } }));
    expect(ran.body.result.isError).toBeUndefined();
    expect(toolText(ran).phase).toBe('execution');
  });
});

describe('portal: connected assistants', () => {
  it('lists own connections, lets the owner disconnect, hides others from developers, admins see all', async () => {
    const mine = await connect(DEV, ['projects:read']);
    await connect(DEV2, ['projects:read']);

    const list = await request(app).get('/api/mcp/connections').set('Authorization', `Bearer ${session(DEV)}`);
    expect(list.status).toBe(200);
    expect(list.body.connectorUrl).toBe(RESOURCE);
    expect(list.body.connections).toHaveLength(1);
    expect(list.body.connections[0]).toMatchObject({ name: 'Claude', scopes: ['projects:read'], approvedBy: { id: DEV.id }, mine: true });
    expect(JSON.stringify(list.body)).not.toMatch(/cairn_(at|rt)_|tokenHash/);

    const adminList = await request(app).get('/api/mcp/connections').set('Authorization', `Bearer ${session(ADMIN)}`);
    expect(adminList.body.connections).toHaveLength(2);

    const otherId = adminList.body.connections.find((c: any) => c.approvedBy.id === DEV2.id).id;
    expect((await request(app).delete(`/api/mcp/connections/${otherId}`).set('Authorization', `Bearer ${session(DEV)}`)).status).toBe(404);

    const id = list.body.connections[0].id;
    const del = await request(app).delete(`/api/mcp/connections/${id}`).set('Authorization', `Bearer ${session(DEV)}`);
    expect(del.status).toBe(200);
    expect((await mcp(mine.access_token, rpc('tools/list'))).status).toBe(401);
    const refresh = await request(app).post('/api/oauth/token').type('form')
      .send({ grant_type: 'refresh_token', client_id: mine.clientId, refresh_token: mine.refresh_token });
    expect(refresh.status).toBe(400);
    expect(audits('mcp.grant.revoke').some((a) => a.metadata.by === 'portal')).toBe(true);

    expect((await request(app).delete(`/api/mcp/connections/${otherId}`).set('Authorization', `Bearer ${session(ADMIN)}`)).status).toBe(200);
  });

  it('agent tokens and connected assistants cannot use the connections API', async () => {
    const r = await request(app).get('/api/mcp/connections').set('Authorization', `Bearer ${RAW_AGENT}`);
    expect(r.status).toBe(403);
  });
});

describe('loopback app (tool calls)', () => {
  it('refuses requests without the internal header, and routes the tools do not use', async () => {
    const loop = await buildLoopbackApp();
    const noHeader = await request(loop).get('/api/health');
    expect(noHeader.status).toBe(403);
    const wrong = await request(loop).get('/api/health').set(MCP_INTERNAL_HEADER, 'f'.repeat(64));
    expect(wrong.status).toBe(403);
    const ok = await request(loop).get('/api/health').set(MCP_INTERNAL_HEADER, mcpInternalSecret());
    expect(ok.status).not.toBe(403);
    const notTool = await request(loop).get('/api/agent-tokens').set(MCP_INTERNAL_HEADER, mcpInternalSecret());
    expect(notTool.status).toBe(404);
    const write = await request(loop).delete('/api/projects/p1').set(MCP_INTERNAL_HEADER, mcpInternalSecret());
    expect(write.status).toBe(404);
  });

  it('the public app does not trust the internal header (only the loopback app can mark a request)', async () => {
    const t = await connect(DEV, ['projects:read']);
    const r = await request(app)
      .get('/api/agent-tokens/me')
      .set('Authorization', `Bearer ${t.access_token}`)
      .set(MCP_INTERNAL_HEADER, mcpInternalSecret());
    expect(r.status).toBe(401);
  });

  it('rejects path traversal and invalid Kubernetes names in tool arguments', async () => {
    const t = await connect(OPS, ['projects:read', 'cluster:read'], mfaSession(OPS));
    const calls: Array<[string, Record<string, unknown>]> = [
      ['platform_get_project', { id: '..' }],
      ['platform_get_project', { id: '.' }],
      ['platform_get_project', { id: 'a/b' }],
      ['platform_get_pod_logs', { namespace: '..', podName: 'web' }],
      ['platform_get_pod_logs', { namespace: 'demo', podName: '..' }],
      ['platform_get_pod_logs', { namespace: 'Demo_NS', podName: 'web' }],
      ['platform_list_pods', { namespace: '../x' }],
    ];
    for (const [name, args] of calls) {
      const r = await mcp(t.access_token, rpc('tools/call', { name, arguments: args }));
      expect(r.body.result.isError).toBe(true);
      expect(JSON.parse(r.body.result.content[0].text).status).toBe(400);
    }
  });
});
