// Mock ESM modules before any imports
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {
    loadFromDefault() {}
    makeApiClient() {
      return {};
    }
  },
  CustomObjectsApi: class {}
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

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { User } from '../../src/entities/User';

// ----------------------------------------------------
// MOCK DATABASE & MONGO CONNECTIONS
// ----------------------------------------------------
const mockUser: any = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'DevOps Boss',
  email: 'devops@pratyushes.dev',
  role: 'devops',
  roleId: null,
  isActive: true,
};

const mockUserRepository = {
  findOne: jest.fn(),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity) => {
    if (entity === User || entity.name === 'User') {
      return mockUserRepository;
    }
    return {};
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(() => Promise.resolve(mockDataSource)),
}));

jest.mock('../../src/config/mongoose', () => ({
  connectMongo: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../src/lib/lokilog', () => ({
  forwardToLoki: jest.fn().mockResolvedValue(true),
}));

process.env.DOMAIN = 'platform.example.test';
process.env.OIDC_CLIENT_SECRET_ARGOCD = 'argocd-test-secret-0123456789';
process.env.OIDC_CLIENT_SECRET_GRAFANA = 'grafana-test-secret-0123456789';

import apiRouter from '../../src/routes/api';
import { resetOidcClientCache } from '../../src/lib/oidc-clients';

const ARGO_REDIRECT = 'https://platform.example.test/argocd/auth/callback';
const ARGO_SECRET = 'argocd-test-secret-0123456789';
const GRAFANA_SECRET = 'grafana-test-secret-0123456789';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

describe('OAuth2 / OIDC SSO Integration Tests', () => {
  let app: express.Express;
  const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';
  let portalToken: string;

  beforeAll(() => {
    // The API never falls back to a default secret; tests must configure it.
    process.env.JWT_SECRET = JWT_SECRET;
    resetOidcClientCache();
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    portalToken = jwt.sign(
      { id: mockUser.id, email: mockUser.email, name: mockUser.name, role: mockUser.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
  });

  beforeEach(() => {
    mockUserRepository.findOne.mockReset();
    mockUserRepository.findOne.mockResolvedValue(mockUser);
  });

  async function issueCode(extra: Record<string, string> = {}, clientId = 'argocd', redirectUri = ARGO_REDIRECT): Promise<string> {
    const res = await request(app)
      .post('/api/oauth/authorize')
      .set('Authorization', `Bearer ${portalToken}`)
      .send({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', state: 'test-state', ...extra });
    expect(res.status).toBe(200);
    return new URL(res.body.redirect).searchParams.get('code')!;
  }

  describe('GET /api/oauth/.well-known/openid-configuration', () => {
    it('should return OIDC discovery metadata with correct sub-routes', async () => {
      const res = await request(app)
        .get('/api/oauth/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe('https://platform.example.test/api/oauth');
      expect(res.body.authorization_endpoint).toContain('/api/oauth/authorize');
      expect(res.body.token_endpoint).toContain('/api/oauth/token');
      expect(res.body.userinfo_endpoint).toContain('/api/oauth/userinfo');
      expect(res.body.jwks_uri).toContain('/api/oauth/jwks');
      expect(res.body.id_token_signing_alg_values_supported).toContain('RS256');
      expect(res.body.response_types_supported).toEqual(['code']);
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.body.token_endpoint_auth_methods_supported).toEqual(['client_secret_basic', 'client_secret_post']);
    });
  });

  describe('GET /api/oauth/jwks', () => {
    it('should return public key in JSON Web Key Set format', async () => {
      const res = await request(app).get('/api/oauth/jwks');

      expect(res.status).toBe(200);
      expect(res.body.keys.length).toBe(1);
      expect(typeof res.body.keys[0].kid).toBe('string');
      expect(res.body.keys[0].kty).toBe('RSA');
      expect(res.body.keys[0].use).toBe('sig');
      expect(res.body.keys[0].n).toBeDefined();
      expect(res.body.keys[0].e).toBeDefined();
      expect(res.body.keys[0].d).toBeUndefined();
    });
  });

  describe('GET /api/oauth/authorize (client registry)', () => {
    it('redirects a registered client + exact redirect_uri to the portal consent page', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, state: 'test-state', response_type: 'code' });

      expect(res.status).toBe(302);
      const loc = new URL(res.headers.location);
      expect(loc.pathname).toBe('/oauth/authorize');
      expect(loc.searchParams.get('client_id')).toBe('argocd');
      expect(loc.searchParams.get('redirect_uri')).toBe(ARGO_REDIRECT);
      expect(loc.searchParams.get('state')).toBe('test-state');
    });

    it('returns 400 if client_id or redirect_uri is missing', async () => {
      const res = await request(app).get('/api/oauth/authorize').query({ client_id: 'argocd' });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('rejects an unknown client_id without redirecting', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'evil', redirect_uri: 'https://evil.example/cb' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.headers.location).toBeUndefined();
    });

    it.each([
      'https://evil.example/cb',
      'http://localhost:8080/auth/callback',
      `${ARGO_REDIRECT}.evil.example`,
      `${ARGO_REDIRECT}/../../evil`,
      `${ARGO_REDIRECT}?x=1`,
      'https://platform.example.test/grafana/login/generic_oauth',
    ])('rejects unregistered redirect_uri %s without redirecting', async (redirectUri) => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'argocd', redirect_uri: redirectUri, state: 's' });
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('never mints a code from a session token in the query string', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, state: 'test-state', token: portalToken });
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('code=');
      expect(res.headers.location).not.toContain(portalToken);
      expect(new URL(res.headers.location).pathname).toBe('/oauth/authorize');
    });
  });

  describe('GET /api/oauth/clients/:id', () => {
    it('returns public client info and redirect validity', async () => {
      const ok = await request(app).get('/api/oauth/clients/argocd').query({ redirect_uri: ARGO_REDIRECT });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ client_id: 'argocd', name: 'Argo CD', redirect_uri_valid: true });
      expect(JSON.stringify(ok.body)).not.toContain(ARGO_SECRET);

      const bad = await request(app).get('/api/oauth/clients/argocd').query({ redirect_uri: 'https://evil.example/cb' });
      expect(bad.body.redirect_uri_valid).toBe(false);

      const unknown = await request(app).get('/api/oauth/clients/nope');
      expect(unknown.status).toBe(404);
    });
  });

  describe('POST /api/oauth/authorize', () => {
    it('requires a session JWT in the Authorization header', async () => {
      const res = await request(app)
        .post('/api/oauth/authorize')
        .send({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, token: portalToken });
      expect(res.status).toBe(401);
    });

    it('returns the registered redirect with code and state', async () => {
      const res = await request(app)
        .post('/api/oauth/authorize')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, state: 'test-state' });
      expect(res.status).toBe(200);
      const loc = new URL(res.body.redirect);
      expect(`${loc.origin}${loc.pathname}`).toBe(ARGO_REDIRECT);
      expect(loc.searchParams.get('code')).toBeTruthy();
      expect(loc.searchParams.get('state')).toBe('test-state');
    });

    it('refuses an unregistered redirect_uri', async () => {
      const res = await request(app)
        .post('/api/oauth/authorize')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ client_id: 'argocd', redirect_uri: 'https://evil.example/cb', state: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.redirect).toBeUndefined();
    });

    it('refuses PKCE plain', async () => {
      const res = await request(app)
        .post('/api/oauth/authorize')
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/oauth/token and GET /api/oauth/userinfo flow', () => {
    it('exchanges a code with client_secret_basic and serves userinfo', async () => {
      const code = await issueCode({ nonce: 'n-123' });
      const res = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .type('form')
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.token_type).toBe('Bearer');

      // ID token verifies against the published JWKS
      const jwks = await request(app).get('/api/oauth/jwks');
      const pub = crypto.createPublicKey({ key: jwks.body.keys[0], format: 'jwk' });
      const idToken: any = jwt.verify(res.body.id_token, pub, { algorithms: ['RS256'] });
      expect(idToken.sub).toBe(mockUser.id);
      expect(idToken.aud).toBe('argocd');
      expect(idToken.iss).toBe('https://platform.example.test/api/oauth');
      expect(idToken.nonce).toBe('n-123');
      expect(idToken.groups).toContain(mockUser.role);
      expect((jwt.decode(res.body.id_token, { complete: true }) as any).header.kid).toBe(jwks.body.keys[0].kid);

      const userinfoRes = await request(app)
        .get('/api/oauth/userinfo')
        .set('Authorization', `Bearer ${res.body.access_token}`);
      expect(userinfoRes.status).toBe(200);
      expect(userinfoRes.body.sub).toBe(mockUser.id);
      expect(userinfoRes.body.email).toBe(mockUser.email);
    });

    it('exchanges a code with client_secret_post', async () => {
      const code = await issueCode();
      const res = await request(app)
        .post('/api/oauth/token')
        .send({ code, client_id: 'argocd', client_secret: ARGO_SECRET, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
    });

    it('rejects missing or wrong client secrets', async () => {
      const code = await issueCode();
      const noSecret = await request(app)
        .post('/api/oauth/token')
        .send({ code, client_id: 'argocd', redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(noSecret.status).toBe(401);
      expect(noSecret.body.error).toBe('invalid_client');

      const wrong = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', 'argocd-secret-placeholder'))
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(wrong.status).toBe(401);
      expect(wrong.headers['www-authenticate']).toContain('Basic');
    });

    it('rejects a code redeemed by another client', async () => {
      const code = await issueCode();
      const res = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('grafana', GRAFANA_SECRET))
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('rejects a redirect_uri that differs from the authorization request', async () => {
      const code = await issueCode();
      const res = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code, redirect_uri: 'https://evil.example/cb', grant_type: 'authorization_code' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('fails to exchange the code twice', async () => {
      const code = await issueCode();
      const first = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(second.status).toBe(400);
      expect(second.body.error).toBe('invalid_grant');
      expect(second.body.error_description).toBe('Invalid or expired authorization code');
    });

    it('enforces PKCE S256 when a code_challenge was sent', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

      const code1 = await issueCode({ code_challenge: challenge, code_challenge_method: 'S256' });
      const missing = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code: code1, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(missing.status).toBe(400);

      const code2 = await issueCode({ code_challenge: challenge, code_challenge_method: 'S256' });
      const wrong = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code: code2, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code', code_verifier: crypto.randomBytes(32).toString('base64url') });
      expect(wrong.status).toBe(400);

      const code3 = await issueCode({ code_challenge: challenge, code_challenge_method: 'S256' });
      const ok = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code: code3, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code', code_verifier: verifier });
      expect(ok.status).toBe(200);
    });

    it('refuses tokens for an inactive user', async () => {
      const code = await issueCode();
      mockUserRepository.findOne.mockResolvedValue({ ...mockUser, isActive: false });
      const res = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(res.status).toBe(400);
      expect(res.body.access_token).toBeUndefined();
    });

    it('does not log authorization codes or tokens', async () => {
      const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
      try {
        const code = await issueCode();
        const res = await request(app)
          .post('/api/oauth/token')
          .set('Authorization', basic('argocd', ARGO_SECRET))
          .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
        await request(app)
          .post('/api/oauth/token')
          .set('Authorization', basic('argocd', ARGO_SECRET))
          .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
        const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
        expect(logged).not.toContain(code);
        expect(logged).not.toContain(res.body.access_token);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('rejects an invalid access token on userinfo', async () => {
      const res = await request(app)
        .get('/api/oauth/userinfo')
        .set('Authorization', 'Bearer invalid_oauth_access_token');
      expect(res.status).toBe(401);
    });

    it('rejects a portal HS256 session JWT on userinfo', async () => {
      const res = await request(app)
        .get('/api/oauth/userinfo')
        .set('Authorization', `Bearer ${portalToken}`);
      expect(res.status).toBe(401);
    });
  });

  describe('fixed issuer + in-cluster server-to-server calls', () => {
    const INTERNAL_HOST = 'platform-api.platform.svc.cluster.local:3000';

    afterEach(() => {
      delete process.env.OIDC_ISSUER;
    });

    it('ignores a spoofed Host header in discovery', async () => {
      const res = await request(app)
        .get('/api/oauth/.well-known/openid-configuration')
        .set('Host', 'evil.example')
        .set('X-Forwarded-Proto', 'http');
      expect(res.body.issuer).toBe('https://platform.example.test/api/oauth');
      for (const k of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri']) {
        expect(res.body[k].startsWith('https://platform.example.test/api/oauth/')).toBe(true);
      }
    });

    it('builds discovery from OIDC_ISSUER when set', async () => {
      process.env.OIDC_ISSUER = 'https://sso.example.test/api/oauth/';
      const res = await request(app).get('/api/oauth/.well-known/openid-configuration');
      expect(res.body.issuer).toBe('https://sso.example.test/api/oauth');
      expect(res.body.token_endpoint).toBe('https://sso.example.test/api/oauth/token');
      expect(res.body.jwks_uri).toBe('https://sso.example.test/api/oauth/jwks');
    });

    it('serves token, userinfo and jwks over the internal URL with iss = the public issuer', async () => {
      const code = await issueCode();
      const tok = await request(app)
        .post('/api/oauth/token')
        .set('Host', INTERNAL_HOST)
        .set('Authorization', basic('argocd', ARGO_SECRET))
        .type('form')
        .send({ code, redirect_uri: ARGO_REDIRECT, grant_type: 'authorization_code' });
      expect(tok.status).toBe(200);
      expect((jwt.decode(tok.body.id_token) as any).iss).toBe('https://platform.example.test/api/oauth');
      expect((jwt.decode(tok.body.access_token) as any).iss).toBe('https://platform.example.test/api/oauth');

      const jwks = await request(app).get('/api/oauth/jwks').set('Host', INTERNAL_HOST);
      expect(jwks.status).toBe(200);

      const ui = await request(app)
        .get('/api/oauth/userinfo')
        .set('Host', INTERNAL_HOST)
        .set('Authorization', `Bearer ${tok.body.access_token}`);
      expect(ui.status).toBe(200);
      expect(ui.body.sub).toBe(mockUser.id);
    });

    it('redirects the consent hand-off to the configured portal, not the request Host', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .set('Host', 'evil.example')
        .query({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, response_type: 'code' });
      expect(res.status).toBe(302);
      expect(res.headers.location.startsWith('https://platform.example.test/oauth/authorize?')).toBe(true);
    });
  });

  describe('OIDC_CLIENTS (installer-provided registry)', () => {
    afterEach(() => {
      delete process.env.OIDC_CLIENTS;
      resetOidcClientCache();
    });

    it('is authoritative: only listed clients and redirect URIs are accepted', async () => {
      process.env.OIDC_CLIENTS = JSON.stringify([
        { id: 'grafana', secret: 'installer-grafana-secret', redirectUris: ['https://platform.example.test/grafana/login/generic_oauth'] },
      ]);
      resetOidcClientCache();

      const argo = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, response_type: 'code' });
      expect(argo.status).toBe(400);
      expect(argo.body.error).toBe('invalid_client');

      const code = await issueCode({}, 'grafana', 'https://platform.example.test/grafana/login/generic_oauth');
      const old = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('grafana', GRAFANA_SECRET))
        .send({ code, redirect_uri: 'https://platform.example.test/grafana/login/generic_oauth', grant_type: 'authorization_code' });
      expect(old.status).toBe(401);

      const code2 = await issueCode({}, 'grafana', 'https://platform.example.test/grafana/login/generic_oauth');
      const ok = await request(app)
        .post('/api/oauth/token')
        .set('Authorization', basic('grafana', 'installer-grafana-secret'))
        .send({ code: code2, redirect_uri: 'https://platform.example.test/grafana/login/generic_oauth', grant_type: 'authorization_code' });
      expect(ok.status).toBe(200);
    });

    it('has no infisical client in the default registry', async () => {
      const res = await request(app).get('/api/oauth/clients/infisical');
      expect(res.status).toBe(404);
    });
  });
});
