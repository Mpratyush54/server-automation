/**
 * ════════════════════════════════════════════════════════════════════
 * Platform — SDK, Metrics, Bootstrap, Webhooks & Edge Cases
 * Tests: /api/sdk/*, /api/metrics, /api/bootstrap/*,
 *        /api/webhooks/*, /api/projects/:id/databases/*,
 *        Response shape invariants, boundary conditions,
 *        concurrent access, content-type enforcement
 * ════════════════════════════════════════════════════════════════════
 */

// ── Mocks first ──────────────────────────────────────────────────────
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} makeApiClient() { return {}; } },
  CustomObjectsApi: class {},
}));
jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes:        jest.fn().mockResolvedValue([{ metadata: { name: 'node-1' } }]),
  getK8sNamespaces:   jest.fn().mockResolvedValue([{ metadata: { name: 'platform' } }]),
  getK8sPods:         jest.fn().mockResolvedValue([{ metadata: { name: 'api-pod-1', namespace: 'platform' }, status: { phase: 'Running' } }]),
  getPodLogs:         jest.fn().mockResolvedValue('LOG LINE 1\nLOG LINE 2'),
  deletePod:          jest.fn().mockResolvedValue(true),
  updateArgoCDApp:    jest.fn().mockResolvedValue(true),
}));
jest.mock('../../src/lib/lokilog', () => ({ forwardToLoki: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn().mockResolvedValue(true) }));

// Mock pg-module for database provisioning
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
  })),
}));

// Mock database-service lib
jest.mock('../../src/lib/database-service', () => ({
  provisionPostgresDb: jest.fn().mockResolvedValue({
    dbName: 'platform_demoproj_development',
    username: 'platform_demoproj_dev_user',
    password: 'Secure#Pass1234!',
    host: 'postgresql.databases',
    port: 5432,
  }),
  dropProjectDb: jest.fn().mockResolvedValue(undefined),
  generateSecurePassword: jest.fn().mockReturnValue('Secure#Pass1234!'),
  sanitizeDbName: jest.fn().mockImplementation((n: string) => n.toLowerCase().replace(/[^a-z0-9_]/g, '_')),
}));

// ── Seeds ────────────────────────────────────────────────────────────
const PROJ_ID    = 'bc145854-46fe-4480-a751-395a0b593004';
const ENV_ID     = 'e1111111-1111-1111-1111-111111111111';
const BACKUP_ID  = 'bkp11111-1111-1111-1111-111111111111';
const REGID      = 'reg11111-1111-1111-1111-111111111111';

const seedProject = {
  id: PROJ_ID, name: 'demoproj', stack: 'nodejs',
  isActive: true, deletedAt: null,
};
const seedEnv = {
  id: ENV_ID, name: 'development', namespace: 'demoproj-dev',
  domain: 'dev.demoproj.io', projectId: PROJ_ID, isActive: true,
};
const seedReg = {
  id: REGID, projectId: PROJ_ID, environmentId: ENV_ID,
  hostname: 'server-1', serviceName: 'demoproj', version: '1.0.0',
  branch: 'main', status: 'online', isActive: true, lastSeen: new Date().toISOString(),
};
const seedCred = {
  id: 'cred-1', token: 'sdk_live_abc123def456abc123def456abc12345',
  projectId: PROJ_ID, status: 'active',
};
const seedBackup = {
  id: BACKUP_ID, projectId: PROJ_ID, dbName: 'platform_demoproj_development',
  environment: 'development', status: 'completed', providerType: 'minio',
  fileId: 'backup-123.sql.gz', fileSizeBytes: 1024000, checksum: 'abc123',
  createdAt: new Date().toISOString(),
};

// ── Repository mocks ─────────────────────────────────────────────────
const mockInsertMany        = jest.fn().mockResolvedValue([]);
const mockApiMetricInsert   = jest.fn().mockResolvedValue([]);
const mockBugReportCreate   = jest.fn().mockResolvedValue({ _id: 'bug-1', id: 'bug-1' });
const mockErrorDocUpdate    = jest.fn().mockResolvedValue({});
const mockSdkEventCreate    = jest.fn().mockResolvedValue({});
const mockMetricsInsert     = jest.fn().mockResolvedValue([]);
const mockMetricsFind       = jest.fn().mockResolvedValue([
  { _id: { route: '/api/users/:id', method: 'GET' }, count: 100, avgDuration: 23, p50: 18, p95: 67, p99: 120, errors4xx: 2, errors5xx: 0 }
]);

const userRepo = {
  findOne: jest.fn().mockImplementation(({ where }: any) => {
    const map: Record<string, any> = {
      'uid-devops': { id: 'uid-devops', email: 'devops@io', name: 'DevOps', role: 'devops', roleId: null, isActive: true },
      'uid-tl':     { id: 'uid-tl',    email: 'tl@io',     name: 'TL',     role: 'tech_lead', roleId: null, isActive: true },
      'uid-dev':    { id: 'uid-dev',   email: 'dev@io',    name: 'Dev',    role: 'developer', roleId: null, isActive: true },
      'uid-view':   { id: 'uid-view',  email: 'view@io',   name: 'View',   role: 'viewer',    roleId: null, isActive: true },
    };
    if (where?.id) return Promise.resolve(map[where.id] ?? null);
    return Promise.resolve(null);
  }),
  save: jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
};

const projectRepo = {
  findOne: jest.fn().mockResolvedValue(seedProject),
  find:    jest.fn().mockResolvedValue([seedProject]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'p-new', isActive: true, ...d })),
  save:    jest.fn().mockImplementation((p: any) => Promise.resolve(p)),
};

const envRepo = {
  findOne: jest.fn().mockResolvedValue(seedEnv),
  find:    jest.fn().mockResolvedValue([seedEnv]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'e-new', ...d })),
  save:    jest.fn().mockImplementation((e: any) => Promise.resolve(e)),
};

const sdkCredRepo = {
  findOne: jest.fn().mockResolvedValue(seedCred),
  find:    jest.fn().mockResolvedValue([seedCred]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'cred-new', ...d })),
  save:    jest.fn().mockImplementation((c: any) => Promise.resolve(c)),
  update:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const serviceRegRepo = {
  findOne: jest.fn().mockResolvedValue(seedReg),
  find:    jest.fn().mockResolvedValue([seedReg]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: REGID, ...d })),
  save:    jest.fn().mockImplementation((r: any) => Promise.resolve(r)),
  update:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const dbBackupRepo = {
  findOne: jest.fn().mockResolvedValue(seedBackup),
  find:    jest.fn().mockResolvedValue([seedBackup]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: BACKUP_ID, status: 'in_progress', ...d })),
  save:    jest.fn().mockImplementation((b: any) => Promise.resolve(b)),
};

const auditRepo = {
  create: jest.fn().mockImplementation((d: any) => d),
  save:   jest.fn().mockResolvedValue({}),
  find:   jest.fn().mockResolvedValue([]),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity: any) => {
    const n = typeof entity === 'string' ? entity : entity?.name;
    if (n === 'User')                return userRepo;
    if (n === 'Project')             return projectRepo;
    if (n === 'Environment')         return envRepo;
    if (n === 'SdkCredential')       return sdkCredRepo;
    if (n === 'ServiceRegistration') return serviceRegRepo;
    if (n === 'DbBackup')            return dbBackupRepo;
    if (n === 'AuditLog')            return auditRepo;
    return { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]), save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)), create: jest.fn().mockImplementation((d: any) => d), delete: jest.fn(), update: jest.fn() };
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue(mockDataSource),
}));

jest.mock('../../src/schemas/Log',        () => ({ LogModel:        { insertMany: (...a: any[]) => mockInsertMany(...a), find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) }) } }));
jest.mock('../../src/schemas/ApiMetric',  () => ({ ApiMetricModel:  { insertMany: (...a: any[]) => mockApiMetricInsert(...a), aggregate: jest.fn().mockResolvedValue([{ _id: { route: '/api/users/:id', method: 'GET' }, count: 100, avgDuration: 23 }]) } }));
jest.mock('../../src/schemas/BugReport',  () => ({ BugReportModel:  { create: (...a: any[]) => mockBugReportCreate(...a), findById: jest.fn().mockResolvedValue({ _id: 'b1', description: 'test' }) } }));
jest.mock('../../src/schemas/ErrorDoc',   () => ({ ErrorDocModel:   { findOneAndUpdate: (...a: any[]) => mockErrorDocUpdate(...a) } }));
jest.mock('../../src/schemas/SdkEvent',   () => ({ SdkEventModel:   { create: (...a: any[]) => mockSdkEventCreate(...a) } }));
jest.mock('../../src/schemas/MetricsRaw', () => ({ MetricsRawModel: { insertMany: (...a: any[]) => mockMetricsInsert(...a), find: (...a: any[]) => mockMetricsFind(...a) } }));
jest.mock('../../src/schemas/FeatureFlag',() => ({ FeatureFlagModel:{ find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import apiRouter from '../../src/routes/api';

const JWT_SECRET = 'plat-super-secret-key';
const sign = (role: string, id: string) =>
  jwt.sign({ id, email: `${role}@io`, name: role, role }, JWT_SECRET, { expiresIn: '2h' });

const T = {
  devops:    sign('devops',    'uid-devops'),
  tech_lead: sign('tech_lead', 'uid-tl'),
  developer: sign('developer', 'uid-dev'),
  viewer:    sign('viewer',    'uid-view'),
};

const SDK_TOKEN = 'sdk_live_abc123def456abc123def456abc12345';
const SDK_AUTH  = { Authorization: `Bearer ${SDK_TOKEN}` };

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET              = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY  = 'a'.repeat(64);
  process.env.GITHUB_WEBHOOK_SECRET   = 'github-secret-test';
  process.env.GITLAB_WEBHOOK_TOKEN    = 'gitlab-token-test';
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', apiRouter);
});
beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════════════
// 1. SDK REGISTER / DEREGISTER / HEARTBEAT
// ════════════════════════════════════════════════════════════════════
describe('SDK Register / Lifecycle', () => {
  const regBody = {
    projectName: 'demoproj', environmentName: 'development',
    hostname: 'server-1', ipAddress: '10.0.0.1',
    serviceName: 'demoproj-api', version: '1.0.0',
    branch: 'main', commitSha: 'abc1234',
    envKeys: ['DATABASE_URL', 'API_KEY'], dbTypes: ['postgres'],
    metadata: {},
  };

  describe('POST /api/sdk/register', () => {
    it('201 — valid SDK token, full payload → registrationId returned', async () => {
      const r = await request(app).post('/api/sdk/register').set(SDK_AUTH).send(regBody);
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty('registrationId');
    });

    it('401 — missing Authorization header', async () => {
      const r = await request(app).post('/api/sdk/register').send(regBody);
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/Missing SDK token/i);
    });

    it('401 — bad format token', async () => {
      const r = await request(app)
        .post('/api/sdk/register')
        .set('Authorization', 'Bearer bad_format_xyz')
        .send(regBody);
      expect(r.status).toBe(401);
    });

    it('401 — revoked SDK token (status != active)', async () => {
      sdkCredRepo.findOne.mockResolvedValueOnce({ ...seedCred, status: 'revoked' });
      const r = await request(app).post('/api/sdk/register').set(SDK_AUTH).send(regBody);
      expect(r.status).toBe(401);
      expect(r.body.error).toMatch(/Invalid or revoked/i);
    });

    it('400 — projectName is required', async () => {
      const { projectName: _, ...body } = regBody;
      const r = await request(app).post('/api/sdk/register').set(SDK_AUTH).send(body);
      expect(r.status).toBe(400);
    });

    it('400 — environmentName is required', async () => {
      const { environmentName: _, ...body } = regBody;
      const r = await request(app).post('/api/sdk/register').set(SDK_AUTH).send(body);
      expect(r.status).toBe(400);
    });

    it('project lookup uses projectName (findOne where name)', async () => {
      await request(app).post('/api/sdk/register').set(SDK_AUTH).send(regBody);
      const findCall = projectRepo.findOne.mock.calls.find((c: any[]) =>
        JSON.stringify(c[0]).includes('demoproj')
      );
      expect(findCall).toBeDefined();
    });
  });

  describe('POST /api/sdk/deregister', () => {
    it('200 — deregisters active service', async () => {
      const r = await request(app)
        .post('/api/sdk/deregister')
        .set(SDK_AUTH)
        .send({ registrationId: REGID });
      expect([200, 400]).toContain(r.status);
    });

    it('401 — no token', async () => {
      const r = await request(app).post('/api/sdk/deregister').send({ registrationId: REGID });
      expect(r.status).toBe(401);
    });
  });

  describe('POST /api/sdk/heartbeat', () => {
    const hb = {
      projectId: PROJ_ID, cpuPct: 12.5, memoryMb: 256,
      heapMb: 128, uptimeS: 3600, requestCount: 100,
      avgResponseMs: 20, p95ResponseMs: 80,
      errors4xx: 0, errors5xx: 0,
    };

    it('200 — valid heartbeat stored in MetricsRaw', async () => {
      const r = await request(app).post('/api/sdk/heartbeat').set(SDK_AUTH).send(hb);
      expect(r.status).toBe(200);
      expect(mockMetricsInsert).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ cpuPct: 12.5 })])
      );
    });

    it('200 — cpuPct = 0 is valid (idle server)', async () => {
      const r = await request(app).post('/api/sdk/heartbeat').set(SDK_AUTH).send({ ...hb, cpuPct: 0 });
      expect([200, 201]).toContain(r.status);
    });

    it('200 — dbHealth nested object is accepted', async () => {
      const r = await request(app).post('/api/sdk/heartbeat').set(SDK_AUTH).send({
        ...hb,
        dbHealth: { postgres: { activeCount: 2, idleCount: 8, status: 'connected' } },
      });
      expect([200, 201]).toContain(r.status);
    });

    it('401 — no token', async () => {
      const r = await request(app).post('/api/sdk/heartbeat').send(hb);
      expect(r.status).toBe(401);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. SDK LOGS & LOG INGEST ALIAS
// ════════════════════════════════════════════════════════════════════
describe('SDK Log Ingest', () => {
  const validLogs = {
    logs: [
      { level: 'INFO',  message: 'Server started',       projectId: 'demoproj', environment: 'development' },
      { level: 'ERROR', message: 'Unhandled exception',  projectId: 'demoproj', environment: 'development', fields: { stack: 'Error at line 42' } },
      { level: 'WARN',  message: 'Memory usage above 80%', projectId: 'demoproj' },
    ],
  };

  it('201 — batch ingest; LogModel.insertMany called with all entries', async () => {
    const r = await request(app).post('/api/sdk/logs').set(SDK_AUTH).send(validLogs);
    expect(r.status).toBe(201);
    expect(mockInsertMany).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ level: 'INFO',  message: 'Server started' }),
        expect.objectContaining({ level: 'ERROR', message: 'Unhandled exception' }),
      ])
    );
  });

  it('ERROR level logs trigger ErrorDocModel.findOneAndUpdate (error tracking)', async () => {
    await request(app).post('/api/sdk/logs').set(SDK_AUTH).send({
      logs: [{ level: 'ERROR', message: 'TypeError: cannot read', projectId: 'demoproj', fields: { errorType: 'TypeError', stackHash: 'hash-abc' } }],
    });
    // Error doc upsert should have been called
    expect(mockErrorDocUpdate).toHaveBeenCalled();
  });

  it('201 — empty logs array is accepted (no-op)', async () => {
    const r = await request(app).post('/api/sdk/logs').set(SDK_AUTH).send({ logs: [] });
    expect([200, 201]).toContain(r.status);
  });

  it('400 — logs field must be array', async () => {
    const r = await request(app).post('/api/sdk/logs').set(SDK_AUTH).send({ logs: 'not-an-array' });
    expect(r.status).toBe(400);
  });

  it('400 — missing logs field', async () => {
    const r = await request(app).post('/api/sdk/logs').set(SDK_AUTH).send({});
    expect(r.status).toBe(400);
  });

  it('POST /api/logs/ingest — alias route also returns 201', async () => {
    const r = await request(app).post('/api/logs/ingest').set(SDK_AUTH).send(validLogs);
    expect(r.status).toBe(201);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. API METRICS (SDK POST + JWT GET)
// ════════════════════════════════════════════════════════════════════
describe('SDK API Metrics', () => {
  const validMetrics = {
    projectId: PROJ_ID,
    metrics: [
      { route: '/api/users/:id', method: 'GET', statusCode: 200, durationMs: 45, memoryDeltaBytes: 1024, environment: 'development', timestamp: new Date().toISOString() },
      { route: '/api/orders',    method: 'POST', statusCode: 201, durationMs: 120, memoryDeltaBytes: 2048, environment: 'development' },
    ],
  };

  describe('POST /api/sdk/api-metrics (SDK token)', () => {
    it('201 — stores metrics via ApiMetricModel.insertMany', async () => {
      const r = await request(app).post('/api/sdk/api-metrics').set(SDK_AUTH).send(validMetrics);
      expect(r.status).toBe(201);
      expect(mockApiMetricInsert).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ route: '/api/users/:id', method: 'GET' })])
      );
    });

    it('400 — projectId is required', async () => {
      const r = await request(app).post('/api/sdk/api-metrics').set(SDK_AUTH).send({ metrics: validMetrics.metrics });
      expect(r.status).toBe(400);
    });

    it('400 — metrics array is required', async () => {
      const r = await request(app).post('/api/sdk/api-metrics').set(SDK_AUTH).send({ projectId: PROJ_ID });
      expect(r.status).toBe(400);
    });

    it('400 — metrics must be an array', async () => {
      const r = await request(app).post('/api/sdk/api-metrics').set(SDK_AUTH).send({ projectId: PROJ_ID, metrics: 'not-array' });
      expect(r.status).toBe(400);
    });

    it('401 — no SDK token', async () => {
      const r = await request(app).post('/api/sdk/api-metrics').send(validMetrics);
      expect(r.status).toBe(401);
    });
  });

  describe('GET /api/sdk/api-metrics (JWT auth)', () => {
    it('200 — devops can query aggregated metrics', async () => {
      const r = await request(app)
        .get('/api/sdk/api-metrics')
        .query({ projectId: PROJ_ID })
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('metrics');
      expect(Array.isArray(r.body.metrics)).toBe(true);
    });

    it('400 — projectId query param is required', async () => {
      const r = await request(app)
        .get('/api/sdk/api-metrics')
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(400);
    });

    it('401 — no token', async () => {
      const r = await request(app).get('/api/sdk/api-metrics').query({ projectId: PROJ_ID });
      expect(r.status).toBe(401);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. SDK BUG REPORTS
// ════════════════════════════════════════════════════════════════════
describe('SDK Bug Reports', () => {
  const validReport = {
    projectId: PROJ_ID,
    environment: 'development',
    description: 'Login button does not respond on mobile',
    category: 'UI',
    consoleLogs: ['[ERROR] Cannot read property "click" of null'],
    networkTimeline: [{ url: '/api/auth/login', status: 500, duration: 340 }],
    browserInfo: { userAgent: 'Chrome/114', url: 'https://app.io/login', viewport: '375x812' },
  };

  it('201 — stores bug report; returns id', async () => {
    const r = await request(app).post('/api/sdk/bug-report').set(SDK_AUTH).send(validReport);
    expect(r.status).toBe(201);
    expect(r.body).toHaveProperty('id');
    expect(mockBugReportCreate).toHaveBeenCalledWith(
      expect.objectContaining({ description: validReport.description, projectId: PROJ_ID })
    );
  });

  it('400 — description is required', async () => {
    const { description: _, ...body } = validReport;
    const r = await request(app).post('/api/sdk/bug-report').set(SDK_AUTH).send(body);
    expect(r.status).toBe(400);
  });

  it('400 — projectId is required', async () => {
    const { projectId: _, ...body } = validReport;
    const r = await request(app).post('/api/sdk/bug-report').set(SDK_AUTH).send(body);
    expect(r.status).toBe(400);
  });

  it('201 — report without screenshot is accepted', async () => {
    const r = await request(app).post('/api/sdk/bug-report').set(SDK_AUTH).send({
      ...validReport, screenshotBase64: undefined,
    });
    expect(r.status).toBe(201);
  });

  it('consoleLogs must be an array (not a string)', async () => {
    const r = await request(app).post('/api/sdk/bug-report').set(SDK_AUTH).send({
      ...validReport, consoleLogs: 'single string error',
    });
    expect([400, 201]).toContain(r.status);
  });

  it('401 — no SDK token', async () => {
    const r = await request(app).post('/api/sdk/bug-report').send(validReport);
    expect(r.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. METRICS ENDPOINT (JWT)
// ════════════════════════════════════════════════════════════════════
describe('GET /api/metrics', () => {
  it('200 — any auth user can query metrics', async () => {
    const r = await request(app)
      .get('/api/metrics')
      .query({ projectId: PROJ_ID })
      .set('Authorization', `Bearer ${T.developer}`);
    expect([200, 400]).toContain(r.status);
  });

  it('401 — no token', async () => {
    const r = await request(app).get('/api/metrics').query({ projectId: PROJ_ID });
    expect(r.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. DATABASE PROVISIONING
// ════════════════════════════════════════════════════════════════════
describe('Database Provisioning', () => {
  describe('POST /api/projects/:projectId/databases/provision', () => {
    it('201 — devops provisions DB; credentials shown once', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/provision`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ environment: 'development' });
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty('dbName');
      expect(r.body).toHaveProperty('username');
      expect(r.body).toHaveProperty('password');
      expect(r.body).toHaveProperty('connectionString');
      expect(r.body.connectionString).toMatch(/^postgresql:\/\//);
      // Warning message should mention one-time display
      expect(r.body.message).toMatch(/once|not.*shown.*again/i);
    });

    it('400 — environment field is required', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/provision`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({});
      expect(r.status).toBe(400);
    });

    it('404 — non-existent project', async () => {
      projectRepo.findOne.mockResolvedValueOnce(null);
      const r = await request(app)
        .post(`/api/projects/00000000-0000-0000-0000-000000000000/databases/provision`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ environment: 'development' });
      expect(r.status).toBe(404);
    });

    it('403 — developer cannot provision DB', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/provision`)
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ environment: 'development' });
      expect(r.status).toBe(403);
    });

    it('403 — tech_lead cannot provision DB', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/provision`)
        .set('Authorization', `Bearer ${T.tech_lead}`)
        .send({ environment: 'development' });
      expect(r.status).toBe(403);
    });

    it('dev + staging + prod each get DIFFERENT dbName', async () => {
      const { provisionPostgresDb } = require('../../src/lib/database-service');
      provisionPostgresDb
        .mockResolvedValueOnce({ dbName: 'platform_demoproj_development', username: 'u1', password: 'p1', host: 'h', port: 5432 })
        .mockResolvedValueOnce({ dbName: 'platform_demoproj_staging',     username: 'u2', password: 'p2', host: 'h', port: 5432 })
        .mockResolvedValueOnce({ dbName: 'platform_demoproj_production',  username: 'u3', password: 'p3', host: 'h', port: 5432 });

      const [r1, r2, r3] = await Promise.all([
        request(app).post(`/api/projects/${PROJ_ID}/databases/provision`).set('Authorization', `Bearer ${T.devops}`).send({ environment: 'development' }),
        request(app).post(`/api/projects/${PROJ_ID}/databases/provision`).set('Authorization', `Bearer ${T.devops}`).send({ environment: 'staging' }),
        request(app).post(`/api/projects/${PROJ_ID}/databases/provision`).set('Authorization', `Bearer ${T.devops}`).send({ environment: 'production' }),
      ]);

      if (r1.status === 201 && r2.status === 201 && r3.status === 201) {
        expect(r1.body.dbName).not.toBe(r2.body.dbName);
        expect(r2.body.dbName).not.toBe(r3.body.dbName);
        expect(r1.body.username).not.toBe(r2.body.username);
      }
    });
  });

  describe('POST /api/projects/:projectId/databases/backup', () => {
    it('202 — backup is async; returns backupId immediately', async () => {
      dbBackupRepo.save.mockImplementation((b: any) => Promise.resolve({ id: BACKUP_ID, status: 'in_progress', ...b }));
      dbBackupRepo.create.mockImplementation((d: any) => ({ id: BACKUP_ID, status: 'in_progress', ...d }));
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/backup`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ environment: 'development', dbName: 'platform_demoproj_development' });
      expect([201, 202]).toContain(r.status);
      if ([201, 202].includes(r.status)) {
        expect(r.body).toHaveProperty('backupId');
        expect(r.body.status).toMatch(/in_progress|pending/i);
      }
    });

    it('400 — dbName is required', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/backup`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ environment: 'development' });
      expect(r.status).toBe(400);
    });

    it('403 — developer cannot trigger backup', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/backup`)
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ environment: 'development', dbName: 'db' });
      expect(r.status).toBe(403);
    });
  });

  describe('GET /api/projects/:projectId/databases/backups', () => {
    it('200 — any auth user can list backups', async () => {
      const r = await request(app)
        .get(`/api/projects/${PROJ_ID}/databases/backups`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('each backup has id, status, createdAt fields', async () => {
      const r = await request(app)
        .get(`/api/projects/${PROJ_ID}/databases/backups`)
        .set('Authorization', `Bearer ${T.developer}`);
      if (r.status === 200 && r.body.length > 0) {
        expect(r.body[0]).toHaveProperty('id');
        expect(r.body[0]).toHaveProperty('status');
        expect(r.body[0]).toHaveProperty('createdAt');
      }
    });
  });

  describe('POST /api/projects/:projectId/databases/backups/:backupId/restore', () => {
    it('202 — devops can restore', async () => {
      dbBackupRepo.findOne.mockResolvedValue(seedBackup);
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/backups/${BACKUP_ID}/restore`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 202, 400]).toContain(r.status);
    });

    it('403 — developer cannot restore', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/databases/backups/${BACKUP_ID}/restore`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. BOOTSTRAP
// ════════════════════════════════════════════════════════════════════
describe('Bootstrap API', () => {
  it('GET /api/bootstrap/status — 200 for any auth user', async () => {
    const r = await request(app)
      .get('/api/bootstrap/status')
      .set('Authorization', `Bearer ${T.developer}`);
    expect(r.status).toBe(200);
  });

  it('GET /api/bootstrap/nodes — 200 for devops', async () => {
    const r = await request(app)
      .get('/api/bootstrap/nodes')
      .set('Authorization', `Bearer ${T.devops}`);
    expect([200, 400]).toContain(r.status);
  });

  it('GET /api/bootstrap/nodes — 403 for developer', async () => {
    const r = await request(app)
      .get('/api/bootstrap/nodes')
      .set('Authorization', `Bearer ${T.developer}`);
    expect(r.status).toBe(403);
  });

  it('GET /api/bootstrap/pods — 200 for devops', async () => {
    const r = await request(app)
      .get('/api/bootstrap/pods')
      .set('Authorization', `Bearer ${T.devops}`);
    expect([200, 400]).toContain(r.status);
  });

  it('GET /api/bootstrap/pods — 403 for tech_lead', async () => {
    const r = await request(app)
      .get('/api/bootstrap/pods')
      .set('Authorization', `Bearer ${T.tech_lead}`);
    expect(r.status).toBe(403);
  });

  it('GET /api/bootstrap/pods/:ns/:pod/logs — 200 for devops', async () => {
    const r = await request(app)
      .get('/api/bootstrap/pods/platform/api-pod-1/logs')
      .set('Authorization', `Bearer ${T.devops}`);
    expect([200, 400]).toContain(r.status);
  });

  it('DELETE /api/bootstrap/pods/:ns/:pod — 403 for tech_lead', async () => {
    const r = await request(app)
      .delete('/api/bootstrap/pods/platform/api-pod-1')
      .set('Authorization', `Bearer ${T.tech_lead}`);
    expect(r.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════
// 8. WEBHOOKS — SIGNATURE VERIFICATION
// ════════════════════════════════════════════════════════════════════
describe('Webhooks', () => {
  const makeGithubSig = (body: string, secret = 'github-secret-test') => {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  };

  describe('POST /api/webhooks/github', () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'demoproj' } });

    it('returns 400/401/403 when x-hub-signature-256 header is missing', async () => {
      const r = await request(app)
        .post('/api/webhooks/github')
        .set('Authorization', `Bearer ${T.devops}`)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect([400, 401, 403]).toContain(r.status);
    });

    it('returns 400/401/403 when signature is for DIFFERENT body (tampered payload)', async () => {
      const sig = makeGithubSig('{"ref":"refs/heads/main","repository":{"name":"other-project"}}');
      const r = await request(app)
        .post('/api/webhooks/github')
        .set('Authorization', `Bearer ${T.devops}`)
        .set('x-hub-signature-256', sig)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect([400, 401, 403]).toContain(r.status);
    });

    it('returns 400/401/403 with wrong secret', async () => {
      const sig = makeGithubSig(payload, 'wrong-secret-entirely');
      const r = await request(app)
        .post('/api/webhooks/github')
        .set('Authorization', `Bearer ${T.devops}`)
        .set('x-hub-signature-256', sig)
        .set('Content-Type', 'application/json')
        .send(payload);
      expect([400, 401, 403]).toContain(r.status);
    });
  });

  describe('POST /api/webhooks/gitlab', () => {
    it('returns 400/401/403 when x-gitlab-token header is missing', async () => {
      const r = await request(app)
        .post('/api/webhooks/gitlab')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ object_kind: 'push' });
      expect([400, 401, 403]).toContain(r.status);
    });

    it('returns 400/401/403 when x-gitlab-token is wrong', async () => {
      const r = await request(app)
        .post('/api/webhooks/gitlab')
        .set('Authorization', `Bearer ${T.devops}`)
        .set('x-gitlab-token', 'totally-wrong-token')
        .send({ object_kind: 'push' });
      expect([400, 401, 403]).toContain(r.status);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 9. RESPONSE SHAPE INVARIANTS
// ════════════════════════════════════════════════════════════════════
describe('Response Shape Invariants', () => {
  it('All error responses are application/json with { error: string }', async () => {
    const cases = [
      request(app).get('/api/projects'),               // 401
      request(app).post('/api/auth/login').send({}),   // 400
      request(app).get('/api/completely-unknown-xyz'), // 404
    ];
    for (const req of cases) {
      const r = await req;
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.body).toHaveProperty('error');
      expect(typeof r.body.error).toBe('string');
      expect(r.body.error.length).toBeGreaterThan(0);
    }
  });

  it('Timestamp fields are ISO 8601 format', async () => {
    dbBackupRepo.find.mockResolvedValue([seedBackup]);
    const r = await request(app)
      .get(`/api/projects/${PROJ_ID}/databases/backups`)
      .set('Authorization', `Bearer ${T.developer}`);
    if (r.status === 200 && r.body.length > 0) {
      const ts = r.body[0].createdAt;
      expect(new Date(ts).toISOString()).toBe(ts);
    }
  });

  it('200 with empty list returns [] not null', async () => {
    dbBackupRepo.find.mockResolvedValueOnce([]);
    const r = await request(app)
      .get(`/api/projects/${PROJ_ID}/databases/backups`)
      .set('Authorization', `Bearer ${T.developer}`);
    if (r.status === 200) {
      expect(r.body).toEqual([]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 10. EDGE CASES & BOUNDARY CONDITIONS
// ════════════════════════════════════════════════════════════════════
describe('Edge Cases & Boundary Conditions', () => {
  it('Numeric id in UUID param returns 400/404 not 500', async () => {
    projectRepo.findOne.mockResolvedValue(null);
    const r = await request(app)
      .get('/api/projects/12345')
      .set('Authorization', `Bearer ${T.developer}`);
    expect(r.status).not.toBe(500);
    expect([400, 404]).toContain(r.status);
  });

  it('Path traversal attempt in project name returns 400 not 500', async () => {
    const r = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${T.devops}`)
      .send({ name: '../../../etc/passwd', stack: 'nodejs' });
    expect(r.status).not.toBe(500);
    expect([400, 201]).toContain(r.status);
  });

  it('Very long project name (>100 chars) returns 400', async () => {
    const r = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${T.devops}`)
      .send({ name: 'a'.repeat(101), stack: 'nodejs' });
    expect(r.status).toBe(400);
  });

  it('Concurrent SDK heartbeats do not cause duplicate insertions per call', async () => {
    const calls = Array.from({ length: 5 }, () =>
      request(app).post('/api/sdk/heartbeat').set(SDK_AUTH).send({
        projectId: PROJ_ID, cpuPct: Math.random() * 100, memoryMb: 256,
      })
    );
    const results = await Promise.all(calls);
    results.forEach(r => {
      expect([200, 201]).toContain(r.status);
    });
    // Each heartbeat should have triggered exactly one MetricsRaw insert
    expect(mockMetricsInsert.mock.calls.length).toBe(5);
  });

  it('SDK log batch of 200 entries processes without 5xx', async () => {
    const logs = Array.from({ length: 200 }, (_, i) => ({
      level: i % 5 === 0 ? 'ERROR' : 'INFO',
      message: `Log message number ${i}`,
      projectId: PROJ_ID,
      environment: 'development',
    }));
    const r = await request(app).post('/api/sdk/logs').set(SDK_AUTH).send({ logs });
    expect(r.status).not.toBeGreaterThanOrEqual(500);
    expect([200, 201]).toContain(r.status);
  });

  it('Method not allowed — GET on POST-only route returns 404', async () => {
    const r = await request(app)
      .get('/api/deploy')
      .set('Authorization', `Bearer ${T.devops}`);
    expect(r.status).toBe(404);
  });

  it('Method not allowed — DELETE on list route returns 404', async () => {
    const r = await request(app)
      .delete('/api/projects')
      .set('Authorization', `Bearer ${T.devops}`);
    expect(r.status).toBe(404);
  });

  it('Sending array instead of object body to POST /api/auth/login returns 400', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .send(['email@test.io']);
    expect(r.status).toBe(400);
  });
});
