import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = {
      id: 'user-1',
      email,
      name: 'Test User',
      role: 'developer',
    };

    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user });
  });

  app.get('/api/projects', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = auth.substring(7);
    try {
      jwt.verify(token, JWT_SECRET);
      res.json([
        { id: 'p1', name: 'Project 1', stack: 'nodejs' },
        { id: 'p2', name: 'Project 2', stack: 'angular' },
      ]);
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  app.post('/api/deploy', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const decoded = jwt.verify(auth.substring(7), JWT_SECRET) as any;
      if (!['devops', 'tech_lead'].includes(decoded.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { projectId, version, branch } = req.body;
      if (!projectId || !version || !branch) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      res.json({
        id: 'dep-1',
        projectId,
        version,
        branch,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  app.get('/api/sdk/config', (req, res) => {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    res.json({
      DATABASE_URL: 'postgres://localhost:5432/plat',
      FEATURE_FLAG_X: 'true',
      SECRET_KEY: '***',
    });
  });

  // Mock OAuth Discovery
  app.get('/api/oauth/.well-known/openid-configuration', (req, res) => {
    const baseUrl = `http://${req.headers.host}/api/oauth`;
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      userinfo_endpoint: `${baseUrl}/userinfo`,
      jwks_uri: `${baseUrl}/jwks`,
    });
  });

  // Mock JWKS
  app.get('/api/oauth/jwks', (req, res) => {
    res.json({
      keys: [
        {
          kid: 'plat-key-1',
          use: 'sig',
          alg: 'RS256',
          kty: 'RSA',
          n: 'mock_n',
          e: 'mock_e',
        }
      ]
    });
  });

  // Mock Token Endpoint
  app.post('/api/oauth/token', (req, res) => {
    const { code } = req.body;
    if (code === 'invalid') {
      return res.status(400).json({ error: 'Invalid or expired authorization code' });
    }
    res.json({
      access_token: 'mock_access_token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: 'mock_id_token',
    });
  });

  // Mock Userinfo Endpoint
  app.get('/api/oauth/userinfo', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || auth !== 'Bearer mock_access_token') {
      return res.status(401).json({ error: 'Authorization header with Bearer token is required' });
    }
    res.json({
      sub: 'user-1',
      name: 'Test User',
      email: 'test@test.com',
      email_verified: true,
      groups: ['devops'],
    });
  });

  return app;
}

describe('API Integration Tests', () => {
  const app = createTestApp();
  let authToken: string;

  beforeAll(() => {
    authToken = jwt.sign(
      { id: 'user-1', email: 'test@test.com', name: 'Test', role: 'devops' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /api/auth/login', () => {
    it('should return JWT token for valid email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'test@test.com' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('test@test.com');
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Email required');
    });
  });

  describe('GET /api/projects', () => {
    it('should return projects with valid token', async () => {
      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);
    });

    it('should return 401 without token', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', 'Bearer invalid-token');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/deploy', () => {
    it('should create deployment with valid auth and data', async () => {
      const res = await request(app)
        .post('/api/deploy')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId: 'p1', version: '1.0.0', branch: 'main' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('pending');
      expect(res.body.projectId).toBe('p1');
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await request(app)
        .post('/api/deploy')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ projectId: 'p1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Missing required fields');
    });

    it('should return 403 for developer role', async () => {
      const devToken = jwt.sign(
        { id: 'user-2', role: 'developer', name: 'Dev', email: 'dev@test.com' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const res = await request(app)
        .post('/api/deploy')
        .set('Authorization', `Bearer ${devToken}`)
        .send({ projectId: 'p1', version: '1.0.0', branch: 'main' });

      expect(res.status).toBe(403);
    });

    it('should return 401 without token', async () => {
      const res = await request(app)
        .post('/api/deploy')
        .send({ projectId: 'p1', version: '1.0.0', branch: 'main' });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/sdk/config', () => {
    it('should return config for valid projectId', async () => {
      const res = await request(app)
        .get('/api/sdk/config')
        .query({ projectId: 'p1' });

      expect(res.status).toBe(200);
      expect(res.body.DATABASE_URL).toBeDefined();
      expect(res.body.FEATURE_FLAG_X).toBe('true');
    });

    it('should return 400 when projectId is missing', async () => {
      const res = await request(app).get('/api/sdk/config');
      expect(res.status).toBe(400);
    });
  });

  describe('OIDC / OAuth2 Endpoints', () => {
    describe('GET /api/oauth/.well-known/openid-configuration', () => {
      it('should return OIDC discovery metadata', async () => {
        const res = await request(app).get('/api/oauth/.well-known/openid-configuration');
        expect(res.status).toBe(200);
        expect(res.body.issuer).toContain('/api/oauth');
        expect(res.body.authorization_endpoint).toContain('/api/oauth/authorize');
        expect(res.body.token_endpoint).toContain('/api/oauth/token');
        expect(res.body.jwks_uri).toContain('/api/oauth/jwks');
      });
    });

    describe('GET /api/oauth/jwks', () => {
      it('should return public keys', async () => {
        const res = await request(app).get('/api/oauth/jwks');
        expect(res.status).toBe(200);
        expect(res.body.keys).toBeDefined();
        expect(res.body.keys[0].kid).toBe('plat-key-1');
      });
    });

    describe('POST /api/oauth/token', () => {
      it('should exchange code for tokens', async () => {
        const res = await request(app)
          .post('/api/oauth/token')
          .send({ code: 'valid_code', client_id: 'argocd' });
        expect(res.status).toBe(200);
        expect(res.body.access_token).toBe('mock_access_token');
        expect(res.body.id_token).toBe('mock_id_token');
      });

      it('should return error for invalid code', async () => {
        const res = await request(app)
          .post('/api/oauth/token')
          .send({ code: 'invalid' });
        expect(res.status).toBe(400);
      });
    });

    describe('GET /api/oauth/userinfo', () => {
      it('should return user profile with valid token', async () => {
        const res = await request(app)
          .get('/api/oauth/userinfo')
          .set('Authorization', 'Bearer mock_access_token');
        expect(res.status).toBe(200);
        expect(res.body.sub).toBe('user-1');
        expect(res.body.email).toBe('test@test.com');
      });

      it('should return 401 without auth header', async () => {
        const res = await request(app).get('/api/oauth/userinfo');
        expect(res.status).toBe(401);
      });
    });
  });
});
