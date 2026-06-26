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
import { getDb } from '../../src/config/database';
import { User } from '../../src/entities/User';

// ----------------------------------------------------
// MOCK DATABASE & MONGO CONNECTIONS
// ----------------------------------------------------
const mockUser = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'DevOps Boss',
  email: 'devops@caps.io',
  role: 'DevOps'
};

const mockUserRepository = {
  findOne: jest.fn().mockResolvedValue(mockUser),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity) => {
    // Return mock repo based on class name or reference
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

// Mock Loki forwarding to avoid lokilog calls
jest.mock('../../src/lib/lokilog', () => ({
  forwardToLoki: jest.fn().mockResolvedValue(true),
}));

import apiRouter from '../../src/routes/api';

describe('OAuth2 / OIDC SSO Integration Tests', () => {
  let app: express.Express;
  const JWT_SECRET = process.env.JWT_SECRET || 'caps-platform-super-secret-key';
  let portalToken: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    portalToken = jwt.sign(
      { id: mockUser.id, email: mockUser.email, name: mockUser.name, role: mockUser.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
  });

  describe('GET /api/oauth/.well-known/openid-configuration', () => {
    it('should return OIDC discovery metadata with correct sub-routes', async () => {
      const res = await request(app)
        .get('/api/oauth/.well-known/openid-configuration');
      
      expect(res.status).toBe(200);
      expect(res.body.issuer).toContain('/api/oauth');
      expect(res.body.authorization_endpoint).toContain('/api/oauth/authorize');
      expect(res.body.token_endpoint).toContain('/api/oauth/token');
      expect(res.body.userinfo_endpoint).toContain('/api/oauth/userinfo');
      expect(res.body.jwks_uri).toContain('/api/oauth/jwks');
      expect(res.body.id_token_signing_alg_values_supported).toContain('RS256');
    });
  });

  describe('GET /api/oauth/jwks', () => {
    it('should return public key in JSON Web Key Set format', async () => {
      const res = await request(app).get('/api/oauth/jwks');
      
      expect(res.status).toBe(200);
      expect(res.body.keys).toBeDefined();
      expect(res.body.keys.length).toBe(1);
      expect(res.body.keys[0].kid).toBe('caps-key-1');
      expect(res.body.keys[0].kty).toBe('RSA');
      expect(res.body.keys[0].use).toBe('sig');
      expect(res.body.keys[0].n).toBeDefined();
      expect(res.body.keys[0].e).toBeDefined();
    });
  });

  describe('GET /api/oauth/authorize', () => {
    it('should redirect to portal oauth authorize page when portal token is missing', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback',
          state: 'test-state'
        });
      
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('/oauth/authorize');
      expect(res.headers.location).toContain('client_id=argocd');
      expect(res.headers.location).toContain('state=test-state');
    });

    it('should return 400 if client_id or redirect_uri is missing', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({ client_id: 'argocd' });
      
      expect(res.status).toBe(400);
    });

    it('should redirect back to client redirect_uri with code when valid token is supplied', async () => {
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback',
          state: 'test-state',
          token: portalToken
        });
      
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('http://localhost:8080/auth/callback');
      expect(res.headers.location).toContain('code=');
      expect(res.headers.location).toContain('state=test-state');
    });
  });

  describe('POST /api/oauth/token and GET /api/oauth/userinfo flow', () => {
    let authCode: string;

    beforeEach(async () => {
      // Obtain a fresh authorization code
      const res = await request(app)
        .get('/api/oauth/authorize')
        .query({
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback',
          state: 'test-state',
          token: portalToken
        });
      
      const loc = res.headers.location;
      const url = new URL(loc);
      authCode = url.searchParams.get('code')!;
    });

    it('should exchange authorization code for access and ID tokens', async () => {
      const res = await request(app)
        .post('/api/oauth/token')
        .send({
          code: authCode,
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback',
          grant_type: 'authorization_code'
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
      expect(res.body.id_token).toBeDefined();
      expect(res.body.token_type).toBe('Bearer');

      // Verify returned ID token contains claims
      const decodedIdToken: any = jwt.decode(res.body.id_token);
      expect(decodedIdToken.sub).toBe(mockUser.id);
      expect(decodedIdToken.email).toBe(mockUser.email);
      expect(decodedIdToken.groups).toContain(mockUser.role);

      // Verify Access token works against userinfo endpoint
      const userinfoRes = await request(app)
        .get('/api/oauth/userinfo')
        .set('Authorization', `Bearer ${res.body.access_token}`);

      expect(userinfoRes.status).toBe(200);
      expect(userinfoRes.body.sub).toBe(mockUser.id);
      expect(userinfoRes.body.email).toBe(mockUser.email);
      expect(userinfoRes.body.groups).toContain(mockUser.role);
    });

    it('should reject access with invalid access token on userinfo', async () => {
      const res = await request(app)
        .get('/api/oauth/userinfo')
        .set('Authorization', 'Bearer invalid_oauth_access_token');

      expect(res.status).toBe(401);
    });

    it('should fail to exchange the code twice', async () => {
      // First exchange
      await request(app)
        .post('/api/oauth/token')
        .send({
          code: authCode,
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback'
        });

      // Second exchange should fail
      const res = await request(app)
        .post('/api/oauth/token')
        .send({
          code: authCode,
          client_id: 'argocd',
          redirect_uri: 'http://localhost:8080/auth/callback'
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid or expired authorization code');
    });
  });
});
