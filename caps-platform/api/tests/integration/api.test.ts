import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'caps-platform-super-secret-key';

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
      DATABASE_URL: 'postgres://localhost:5432/caps',
      FEATURE_FLAG_X: 'true',
      SECRET_KEY: '***',
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
});
