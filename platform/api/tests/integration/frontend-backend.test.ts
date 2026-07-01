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

// MOCK DATABASE & MONGO CONNECTIONS
const mockUser = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'DevOps Boss',
  email: 'devops@@dev.io',
  role: 'devops' // matches UserRole.DEVOPS
};

const mockProject = {
  id: 'p1111111-1111-1111-1111-111111111111',
  name: 'test-project',
  stack: 'nodejs',
  environments: [],
  deployments: []
};

const mockEnvironment = {
  id: 'e1111111-1111-1111-1111-111111111111',
  name: 'development',
  namespace: 'test-project-development',
  domain: 'test-project-development.example.com',
  projectId: 'p1111111-1111-1111-1111-111111111111'
};

const mockAuditLog = {
  id: 'a1111111-1111-1111-1111-111111111111',
  userId: '00000000-0000-0000-0000-000000000001',
  action: 'database.provisioned',
  targetType: 'Project',
  targetId: 'p1111111-1111-1111-1111-111111111111',
  createdAt: new Date()
};

const mockUserRepository = {
  findOne: jest.fn().mockImplementation(({ where }) => {
    if (where.email === 'devops@@dev.io' || where.id === mockUser.id) {
      return Promise.resolve(mockUser);
    }
    if (where.email === 'dev@@dev.io' || where.id === '00000002') {
      return Promise.resolve({
        id: '00000002',
        name: 'Dev Boss',
        email: 'dev@@dev.io',
        role: 'developer'
      });
    }
    return Promise.resolve(null);
  }),
  save: jest.fn().mockImplementation((user) => Promise.resolve(user)),
};

const mockProjectRepository = {
  find: jest.fn().mockResolvedValue([mockProject]),
  findOne: jest.fn().mockResolvedValue(mockProject),
  create: jest.fn().mockImplementation((data) => ({ id: 'p1111111-1111-1111-1111-111111111111', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockEnvironmentRepository = {
  findOne: jest.fn().mockResolvedValue(mockEnvironment),
  create: jest.fn().mockImplementation((data) => ({ id: 'e1111111-1111-1111-1111-111111111111', ...data })),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockAuditLogRepository = {
  find: jest.fn().mockResolvedValue([mockAuditLog]),
  create: jest.fn().mockImplementation((data) => data),
  save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity) => {
    const name = typeof entity === 'string' ? entity : entity.name;
    if (name === 'User') return mockUserRepository;
    if (name === 'Project') return mockProjectRepository;
    if (name === 'Environment') return mockEnvironmentRepository;
    if (name === 'AuditLog') return mockAuditLogRepository;
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

// Mock Database provisioning execution
jest.mock('../../src/lib/database-service', () => ({
  provisionPostgresDb: jest.fn().mockResolvedValue({
    dbName: 'plat_testproject_development',
    username: 'plat_testproject_development_user',
    password: 'securepassword123',
    host: 'localhost',
    port: 5432
  }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import apiRouter from '../../src/routes/api';

describe('Frontend & Backend Integration Tests', () => {
  let app: express.Express;
  const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';
  let portalToken: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', apiRouter);

    // Create a mock token signed using the platform secret
    portalToken = jwt.sign(
      { id: mockUser.id, email: mockUser.email, name: mockUser.name, role: mockUser.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
  });

  describe('POST /api/auth/login', () => {
    it('should authenticate a valid user and return a JWT token with user object', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'devops@@dev.io' });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.user.email).toBe('devops@@dev.io');
      expect(res.body.user.role).toBe('devops');
      expect(mockUserRepository.findOne).toHaveBeenCalled();
    });

    it('should return 401 when email is unknown', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'unknown@@dev.io' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('GET /api/projects', () => {
    it('should require authentication and return projects list', async () => {
      const res = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${portalToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].name).toBe('test-project');
    });

    it('should return 401 if token is missing', async () => {
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/projects/:projectId/databases/provision', () => {
    it('should provision a Postgres database for DevOps user', async () => {
      const res = await request(app)
        .post(`/api/projects/${mockProject.id}/databases/provision`)
        .set('Authorization', `Bearer ${portalToken}`)
        .send({ environment: 'development' });

      expect(res.status).toBe(201);
      expect(res.body.dbName).toBe('plat_testproject_development');
      expect(res.body.username).toBe('plat_testproject_development_user');
      expect(res.body.password).toBeDefined();
      expect(res.body.host).toBe('localhost');
      expect(res.body.port).toBe(5432);
    });

    it('should fail with 403 Forbidden for a regular developer user', async () => {
      const devToken = jwt.sign(
        { id: '00000002', email: 'dev@@dev.io', name: 'Dev', role: 'developer' },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      const res = await request(app)
        .post(`/api/projects/${mockProject.id}/databases/provision`)
        .set('Authorization', `Bearer ${devToken}`)
        .send({ environment: 'development' });

      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/audit-logs', () => {
    it('should fetch audit logs for authorized user', async () => {
      const res = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${portalToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].action).toBe('database.provisioned');
    });
  });
});
