/** Remote MCP OAuth helpers (#193): redirect URI rules, name sanitising, scope ceiling, project scoping. */
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: (e: any) => mockRepo(typeof e === 'string' ? e : e?.name) })),
}));

import { sanitizeClientName, validateRedirectUri, validateRegistration, validateGrantedScopes } from '../../../src/lib/mcp-oauth';
import { allowedScopesForRole, consentScopeOptions, defaultScopesForRole, effectiveScopes, parseScopeParam } from '../../../src/lib/mcp-scopes';
import { getPublicBaseUrl, isOurMcpResource } from '../../../src/lib/mcp-public-url';
import { listAccessibleProjectIds, requireProjectAccess } from '../../../src/lib/project-access';

describe('validateRedirectUri', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'http://127.0.0.1:33418/callback',
    'http://localhost:6274/oauth/callback',
    'http://[::1]:8080/cb',
  ])('accepts %s', (uri) => expect(validateRedirectUri(uri)).toBe(uri));

  it.each([
    'http://example.com/cb',
    'http://127.0.0.1.example.com/cb',
    'https://app.example/cb#frag',
    'https://user:pw@app.example/cb',
    'javascript:alert(1)',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
    'https://app.example/c b',
    '/relative',
    '',
  ])('rejects %s', (uri) => expect(validateRedirectUri(uri)).toBeNull());
});

describe('sanitizeClientName', () => {
  it('drops control, format and bidi characters and markup brackets', () => {
    expect(sanitizeClientName('Cla‮ude​\u0007 <img>')).toBe('Cla ude img');
  });
  it('defaults and caps', () => {
    expect(sanitizeClientName(undefined)).toBe('Unnamed assistant');
    expect(sanitizeClientName('   ')).toBe('Unnamed assistant');
    expect(Array.from(sanitizeClientName('a'.repeat(500))).length).toBe(80);
  });
});

describe('validateRegistration', () => {
  it('defaults grant types and dedupes redirect URIs', () => {
    const r = validateRegistration({ redirect_uris: ['https://a.example/cb', 'https://a.example/cb'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.redirectUris).toEqual(['https://a.example/cb']);
      expect(r.value.grantTypes).toEqual(['authorization_code', 'refresh_token']);
    }
  });
  it('requires authorization_code when grant_types is given', () => {
    expect(validateRegistration({ redirect_uris: ['https://a.example/cb'], grant_types: ['refresh_token'] }).ok).toBe(false);
  });
});

describe('scope ceiling', () => {
  it('maps roles to grantable scopes', () => {
    expect(allowedScopesForRole('viewer')).toEqual(['projects:read', 'logs:read']);
    expect(allowedScopesForRole('tech_lead')).toEqual(['projects:read', 'logs:read', 'audit:read', 'commands:validate']);
    expect(allowedScopesForRole('admin')).toContain('commands:execute');
    expect(allowedScopesForRole('nope')).toEqual([]);
  });
  it('defaults are read-only', () => {
    expect(defaultScopesForRole('admin')).toEqual(['projects:read', 'logs:read', 'audit:read', 'cluster:read', 'bootstrap:read']);
  });
  it('effective scopes re-apply the ceiling and ignore unknown entries', () => {
    expect(effectiveScopes(['projects:read', 'cluster:read', '*', 'replays:read'], 'developer')).toEqual(['projects:read']);
  });
  it('parses the OAuth scope parameter', () => {
    expect(parseScopeParam('openid logs:read  projects:read bogus')).toEqual(['projects:read', 'logs:read']);
  });
  it('consent options never tick write scopes', () => {
    const opts = consentScopeOptions(['commands:execute', 'projects:read'], 'admin');
    expect(opts.find((o) => o.id === 'commands:execute')).toMatchObject({ allowed: true, requested: true, checked: false });
    expect(opts.find((o) => o.id === 'projects:read')).toMatchObject({ checked: true });
    expect(opts.find((o) => o.id === 'logs:read')).toMatchObject({ checked: false });
  });
  it('validateGrantedScopes refuses unknown or above-role scopes', () => {
    expect(validateGrantedScopes(['projects:read'], allowedScopesForRole('viewer')).ok).toBe(true);
    expect(validateGrantedScopes(['commands:execute'], allowedScopesForRole('viewer')).ok).toBe(false);
    expect(validateGrantedScopes(['*'], allowedScopesForRole('admin')).ok).toBe(false);
    expect(validateGrantedScopes([], allowedScopesForRole('admin')).ok).toBe(false);
  });
});

describe('public URL', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('comes from configuration only', () => {
    delete process.env.MCP_PUBLIC_URL;
    process.env.DOMAIN = 'cairn.example.test';
    expect(getPublicBaseUrl()).toBe('https://cairn.example.test');
    expect(isOurMcpResource('https://cairn.example.test/mcp/')).toBe(true);
    expect(isOurMcpResource('https://evil.example/mcp')).toBe(false);
    process.env.MCP_PUBLIC_URL = 'http://localhost:3000/ignored-path';
    expect(getPublicBaseUrl()).toBe('http://localhost:3000');
    delete process.env.MCP_PUBLIC_URL;
    delete process.env.DOMAIN;
    expect(getPublicBaseUrl()).toBeNull();
  });
});

describe('project scoping of connected assistants', () => {
  const dev = { id: 'u-dev', role: 'developer' as any, roleId: null, name: 'Dev', email: 'd@x' };
  beforeEach(() => {
    for (const k of Object.keys(mockRepos)) delete mockRepos[k];
    mockRepo('ProjectMember').rows.push({ id: 'pm1', projectId: 'p-mine', userId: 'u-dev', role: 'viewer' });
  });

  it('a plain agent token with projects:read sees all projects; a connected assistant only its person\'s', async () => {
    expect(await listAccessibleProjectIds(undefined, { scopes: ['projects:read'] })).toBeNull();
    expect(await listAccessibleProjectIds(undefined, { scopes: ['projects:read'], delegatedUser: dev })).toEqual(['p-mine']);
    expect(await listAccessibleProjectIds(undefined, { scopes: ['logs:read'], delegatedUser: dev })).toEqual([]);
    expect(await listAccessibleProjectIds(undefined, { scopes: ['projects:read'], delegatedUser: { id: 'a', role: 'admin' } })).toBeNull();
  });

  it('requireProjectAccess checks the person\'s membership', async () => {
    const req: any = { agentToken: { id: 'g', name: 'Claude', scopes: ['projects:read'], tokenPrefix: 'mcp', kind: 'mcp_grant', delegatedUser: dev } };
    expect((await requireProjectAccess(req, 'p-mine')).ok).toBe(true);
    expect((await requireProjectAccess(req, 'p-other')).ok).toBe(false);
  });
});

describe('tool argument path segments (shared registry)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { safePathSegment, k8sNamespace, k8sObjectName } = require('../../../src/mcp/registry');
  it.each(['..', '.', '', 'a/b', 'a\b', 'x\u0000y', 'z'.repeat(201)])('rejects path segment %p', (v) => {
    expect(() => safePathSegment(v, 'id')).toThrow(/Invalid id/);
  });
  it('encodes a normal segment', () => {
    expect(safePathSegment('my app', 'id')).toBe('my%20app');
  });
  it('checks DNS-1123 names', () => {
    expect(k8sNamespace('kube-system')).toBe('kube-system');
    expect(() => k8sNamespace('Kube')).toThrow();
    expect(() => k8sNamespace('a'.repeat(64))).toThrow();
    expect(k8sObjectName('web-1.v2', 'pod')).toBe('web-1.v2');
    expect(() => k8sObjectName('..', 'pod')).toThrow();
    expect(() => k8sObjectName('-web', 'pod')).toThrow();
  });
});
