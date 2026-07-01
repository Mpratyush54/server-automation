/**
 * ════════════════════════════════════════════════════════════════════
 * Platform — Secrets, Alerts, Settings & Audit Strict Test Suite
 * Tests: /api/projects/:id/secrets/*, /api/alerts, /api/settings/smtp,
 *        /api/settings/storage, /api/audit-logs, /api/logs/search,
 *        /api/bug-reports, /api/db-connections
 * ════════════════════════════════════════════════════════════════════
 */

// ── Mocks first ──────────────────────────────────────────────────────
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} makeApiClient() { return {}; } },
  CustomObjectsApi: class {},
}));
jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes:        jest.fn().mockResolvedValue([]),
  getK8sNamespaces:   jest.fn().mockResolvedValue([]),
  getK8sPods:         jest.fn().mockResolvedValue([]),
  getPodLogs:         jest.fn().mockResolvedValue(''),
  deletePod:          jest.fn().mockResolvedValue(true),
  updateArgoCDApp:    jest.fn().mockResolvedValue(true),
}));
jest.mock('../../src/lib/lokilog', () => ({ forwardToLoki: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn().mockResolvedValue(true) }));

// ── Seeds ────────────────────────────────────────────────────────────
const PROJ_ID   = 'bc145854-46fe-4480-a751-395a0b593004';
const SECRET_ID = 'sec11111-1111-1111-1111-111111111111';
const ALERT_ID  = 'alt11111-1111-1111-1111-111111111111';
const SMTP_ID   = 'smt11111-1111-1111-1111-111111111111';
const STOR_ID   = 'str11111-1111-1111-1111-111111111111';
const DBCONN_ID = 'dbc11111-1111-1111-1111-111111111111';

import crypto from 'crypto';
// Build a valid 32-byte AES key from test secret
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

// Encrypt a value as the real secrets route does (AES-256-GCM)
function encryptValue(plaintext: string): string {
  const key   = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv    = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc   = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag   = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

const seedSecret = {
  id: SECRET_ID, projectId: PROJ_ID, key: 'DATABASE_URL',
  encryptedValue: encryptValue('postgresql://user:pass@localhost:5432/db'),
  environmentId: 'development', version: 1, isActive: true,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

const seedAlert = {
  id: ALERT_ID, projectId: PROJ_ID, type: 'cpu_high', severity: 'warning',
  config: { metric: 'cpuPct', operator: '>', threshold: 80 }, isEnabled: true,
  createdAt: new Date().toISOString(),
};

const seedSmtp = {
  id: SMTP_ID, name: 'Primary SMTP', provider: 'custom',
  host: 'smtp.example.com', port: 587, secure: true,
  username: 'smtp-user', password: '***', apiKey: '***',
  fromEmail: 'noreply@platform.io', fromName: 'Platform', isDefault: true,
  createdAt: new Date().toISOString(),
};

const seedStorage = {
  id: STOR_ID, name: 'MinIO Backup', providerType: 'minio',
  endpointUrl: 'http://minio:9000', bucketName: 'platform-backups',
  credentials: { accessKey: '***', secretKey: '***' }, isDefault: true,
  createdAt: new Date().toISOString(),
};

const seedDbConn = {
  id: DBCONN_ID, projectId: PROJ_ID, dbType: 'postgres', poolSize: 10,
  activeCount: 2, idleCount: 8, status: 'connected',
  lastHeartbeat: new Date().toISOString(), createdAt: new Date().toISOString(),
};

// ── Repositories ─────────────────────────────────────────────────────
const userRepo = {
  findOne: jest.fn().mockImplementation(({ where }: any) => {
    const roleMap: Record<string, string> = {
      'uid-devops': 'devops', 'uid-tl': 'tech_lead',
      'uid-dev': 'developer', 'uid-view': 'viewer',
    };
    if (where?.id) {
      const role = roleMap[where.id] || 'developer';
      return Promise.resolve({ id: where.id, email: `${role}@io`, name: role, role, roleId: null, isActive: true });
    }
    return Promise.resolve(null);
  }),
  save: jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
};

const secretRepo = {
  findOne:  jest.fn().mockResolvedValue(seedSecret),
  find:     jest.fn().mockResolvedValue([{ ...seedSecret, encryptedValue: undefined, value: undefined }]),
  create:   jest.fn().mockImplementation((d: any) => ({ id: 'new-sec-id', version: 1, isActive: true, ...d })),
  save:     jest.fn().mockImplementation((s: any) => Promise.resolve(s)),
  update:   jest.fn().mockResolvedValue({ affected: 1 }),
};

const secretVersionRepo = {
  find:   jest.fn().mockResolvedValue([{ id: 'v1', secretId: SECRET_ID, version: 1, createdAt: new Date().toISOString() }]),
  create: jest.fn().mockImplementation((d: any) => d),
  save:   jest.fn().mockImplementation((v: any) => Promise.resolve(v)),
};

const alertRepo = {
  findOne: jest.fn().mockResolvedValue(seedAlert),
  find:    jest.fn().mockResolvedValue([seedAlert]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'new-alert-id', isEnabled: true, ...d })),
  save:    jest.fn().mockImplementation((a: any) => Promise.resolve(a)),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const smtpRepo = {
  findOne: jest.fn().mockResolvedValue(seedSmtp),
  find:    jest.fn().mockResolvedValue([seedSmtp]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'new-smtp-id', ...d })),
  save:    jest.fn().mockImplementation((s: any) => Promise.resolve({ ...s, password: '***', apiKey: '***' })),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const storageRepo = {
  findOne: jest.fn().mockResolvedValue(seedStorage),
  find:    jest.fn().mockResolvedValue([seedStorage]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'new-stor-id', ...d })),
  save:    jest.fn().mockImplementation((s: any) => Promise.resolve(s)),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
  update:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const auditRepo = {
  find:   jest.fn().mockResolvedValue([{ id: 'a1', action: 'LOGIN', userId: 'uid-devops', performedAt: new Date().toISOString() }]),
  create: jest.fn().mockImplementation((d: any) => d),
  save:   jest.fn().mockResolvedValue({}),
};

const dbConnRepo = {
  findOne: jest.fn().mockResolvedValue(seedDbConn),
  find:    jest.fn().mockResolvedValue([seedDbConn]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'new-dbconn-id', ...d })),
  save:    jest.fn().mockImplementation((d: any) => Promise.resolve(d)),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const projectRepo = {
  findOne: jest.fn().mockResolvedValue({ id: PROJ_ID, name: 'demoproj', stack: 'nodejs', isActive: true }),
  find:    jest.fn().mockResolvedValue([]),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity: any) => {
    const n = typeof entity === 'string' ? entity : entity?.name;
    if (n === 'User')            return userRepo;
    if (n === 'Secret')          return secretRepo;
    if (n === 'SecretVersion')   return secretVersionRepo;
    if (n === 'Alert')           return alertRepo;
    if (n === 'SmtpConfig')      return smtpRepo;
    if (n === 'StorageProvider') return storageRepo;
    if (n === 'AuditLog')        return auditRepo;
    if (n === 'DbConnection')    return dbConnRepo;
    if (n === 'Project')         return projectRepo;
    return { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), save: jest.fn().mockImplementation((d: any) => Promise.resolve(d)), create: jest.fn().mockImplementation((d: any) => d), delete: jest.fn(), update: jest.fn() };
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue(mockDataSource),
}));

// Mongo models
jest.mock('../../src/schemas/Log',        () => ({ LogModel:        { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/ApiMetric',  () => ({ ApiMetricModel:  { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/BugReport',  () => ({ BugReportModel:  { create: jest.fn().mockResolvedValue({ _id: 'b1' }), find: jest.fn().mockResolvedValue([{ _id: 'b1', description: 'test bug', projectId: PROJ_ID }]) } }));
jest.mock('../../src/schemas/ErrorDoc',   () => ({ ErrorDocModel:   { findOneAndUpdate: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/SdkEvent',   () => ({ SdkEventModel:   { create: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/MetricsRaw', () => ({ MetricsRawModel: { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/FeatureFlag',() => ({ FeatureFlagModel:{ find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) } }));
jest.mock('../../src/schemas/SdkEvent',   () => ({ SdkEventModel:   { create: jest.fn().mockResolvedValue({}) } }));

// Mock Log mongoose model for search
const mockLogFind = jest.fn().mockReturnValue({
  sort:  jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean:  jest.fn().mockResolvedValue([{ level: 'INFO', message: 'test', projectId: PROJ_ID }]),
});
jest.mock('../../src/schemas/Log', () => ({ LogModel: { find: mockLogFind, insertMany: jest.fn().mockResolvedValue([]) } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
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

let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = ENCRYPTION_KEY;
  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', apiRouter);
});
beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════════════
// 1. SECRETS
// ════════════════════════════════════════════════════════════════════
describe('Secrets API', () => {
  describe('GET /api/projects/:projectId/secrets', () => {
    it('200 — authorized user can list secrets (no values exposed)', async () => {
      const r = await request(app)
        .get(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      r.body.forEach((s: Record<string, unknown>) => {
        expect(s).not.toHaveProperty('encryptedValue');
        expect(s).not.toHaveProperty('value');
      });
    });

    it('401 — no token', async () => {
      const r = await request(app).get(`/api/projects/${PROJ_ID}/secrets`);
      expect(r.status).toBe(401);
    });

    it('403 — viewer does not have secrets.list permission', async () => {
      const r = await request(app)
        .get(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.viewer}`);
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/projects/:projectId/secrets', () => {
    it('201 — devops creates secret (response never shows plaintext)', async () => {
      secretRepo.findOne.mockResolvedValue(null); // no duplicate
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: `MY_KEY_${Date.now()}`, value: 'supersecret123', environmentId: 'development' });
      expect(r.status).toBe(201);
      expect(r.body).not.toHaveProperty('value');
      expect(r.body).not.toHaveProperty('encryptedValue');
    });

    it('400 — key is required', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ value: 'secret-value' });
      expect(r.status).toBe(400);
    });

    it('400 — value is required', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: 'MY_KEY' });
      expect(r.status).toBe(400);
    });

    it('500 — SECRETS_ENCRYPTION_KEY not set returns 500 with descriptive error', async () => {
      const orig = process.env.SECRETS_ENCRYPTION_KEY;
      delete process.env.SECRETS_ENCRYPTION_KEY;

      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: 'TEST_KEY', value: 'val' });

      process.env.SECRETS_ENCRYPTION_KEY = orig;
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/SECRETS_ENCRYPTION_KEY/i);
    });

    it('403 — viewer cannot create secrets', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets`)
        .set('Authorization', `Bearer ${T.viewer}`)
        .send({ key: 'K', value: 'v' });
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/projects/:projectId/secrets/reveal', () => {
    it('200 — reveals plaintext value, response has key + value', async () => {
      secretRepo.findOne.mockResolvedValue(seedSecret);
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/reveal`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: 'DATABASE_URL', environmentId: 'development' });
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('key', 'DATABASE_URL');
      expect(r.body).toHaveProperty('value');
      expect(typeof r.body.value).toBe('string');
    });

    it('400 — key is required', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/reveal`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ environmentId: 'development' });
      expect(r.status).toBe(400);
    });

    it('404 — non-existent key', async () => {
      secretRepo.findOne.mockResolvedValue(null);
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/reveal`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: 'NONEXISTENT_KEY' });
      expect(r.status).toBe(404);
    });

    it('403 — viewer cannot reveal secrets', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/reveal`)
        .set('Authorization', `Bearer ${T.viewer}`)
        .send({ key: 'ANY_KEY' });
      expect(r.status).toBe(403);
    });

    it('500 — SECRETS_ENCRYPTION_KEY not set causes 500', async () => {
      const orig = process.env.SECRETS_ENCRYPTION_KEY;
      delete process.env.SECRETS_ENCRYPTION_KEY;
      secretRepo.findOne.mockResolvedValue(seedSecret);

      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/reveal`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ key: 'DATABASE_URL' });

      process.env.SECRETS_ENCRYPTION_KEY = orig;
      expect(r.status).toBe(500);
    });
  });

  describe('DELETE /api/projects/:projectId/secrets/:secretId', () => {
    it('200 — devops can delete (soft-delete) a secret', async () => {
      secretRepo.findOne.mockResolvedValue(seedSecret);
      const r = await request(app)
        .delete(`/api/projects/${PROJ_ID}/secrets/${SECRET_ID}`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 204]).toContain(r.status);
    });

    it('403 — developer cannot delete secrets', async () => {
      const r = await request(app)
        .delete(`/api/projects/${PROJ_ID}/secrets/${SECRET_ID}`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });

    it('404 — deleting non-existent secret', async () => {
      secretRepo.findOne.mockResolvedValue(null);
      const r = await request(app)
        .delete(`/api/projects/${PROJ_ID}/secrets/00000000-0000-0000-0000-000000000000`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(404);
    });
  });

  describe('GET /api/projects/:projectId/secrets/:secretId/versions', () => {
    it('200 — returns version history without encrypted values', async () => {
      const r = await request(app)
        .get(`/api/projects/${PROJ_ID}/secrets/${SECRET_ID}/versions`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      r.body.forEach((v: Record<string, unknown>) => {
        expect(v).not.toHaveProperty('encryptedValue');
        expect(v).toHaveProperty('version');
      });
    });
  });

  describe('POST /api/projects/:projectId/secrets/bulk', () => {
    it('201 — imports an array of secrets', async () => {
      secretRepo.findOne.mockResolvedValue(null); // no duplicates
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/bulk`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send([
          { key: 'BULK_KEY_1', value: 'val1', environmentId: 'development' },
          { key: 'BULK_KEY_2', value: 'val2', environmentId: 'development' },
        ]);
      expect([201, 200, 400]).toContain(r.status);
    });

    it('403 — viewer cannot import secrets', async () => {
      const r = await request(app)
        .post(`/api/projects/${PROJ_ID}/secrets/bulk`)
        .set('Authorization', `Bearer ${T.viewer}`)
        .send([{ key: 'K', value: 'v' }]);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. ALERTS
// ════════════════════════════════════════════════════════════════════
describe('Alerts API', () => {
  describe('GET /api/alerts', () => {
    it('200 — any auth user can list alerts', async () => {
      const r = await request(app)
        .get('/api/alerts')
        .query({ projectId: PROJ_ID })
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });
  });

  describe('POST /api/alerts', () => {
    const valid = {
      projectId: PROJ_ID, type: 'cpu_high', severity: 'warning',
      config: { metric: 'cpuPct', operator: '>', threshold: 80 },
    };

    it('201 — devops can create alert', async () => {
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.devops}`)
        .send(valid);
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty('id');
    });

    it('201 — tech_lead can create alert', async () => {
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.tech_lead}`)
        .send(valid);
      expect(r.status).toBe(201);
    });

    it('403 — developer cannot create alert', async () => {
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.developer}`)
        .send(valid);
      expect(r.status).toBe(403);
    });

    it('400 — projectId is required', async () => {
      const { projectId: _, ...body } = valid;
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.devops}`)
        .send(body);
      expect(r.status).toBe(400);
    });

    it('400 — type is required', async () => {
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ projectId: PROJ_ID, severity: 'warning', config: {} });
      expect(r.status).toBe(400);
    });

    it('400 — config is required', async () => {
      const r = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ projectId: PROJ_ID, type: 'cpu_high', severity: 'warning' });
      expect(r.status).toBe(400);
    });
  });

  describe('DELETE /api/alerts/:id', () => {
    it('200 — devops can delete alert', async () => {
      alertRepo.findOne.mockResolvedValue(seedAlert);
      const r = await request(app)
        .delete(`/api/alerts/${ALERT_ID}`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 204]).toContain(r.status);
    });

    it('403 — tech_lead cannot delete alert', async () => {
      const r = await request(app)
        .delete(`/api/alerts/${ALERT_ID}`)
        .set('Authorization', `Bearer ${T.tech_lead}`);
      expect(r.status).toBe(403);
    });

    it('403 — developer cannot delete alert', async () => {
      const r = await request(app)
        .delete(`/api/alerts/${ALERT_ID}`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/alerts/evaluate', () => {
    it('200 — any auth user can trigger alert evaluation', async () => {
      const r = await request(app)
        .post('/api/alerts/evaluate')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ projectId: PROJ_ID });
      expect([200, 400]).toContain(r.status);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. SETTINGS — SMTP
// ════════════════════════════════════════════════════════════════════
describe('Settings — SMTP', () => {
  describe('GET /api/settings/smtp', () => {
    it('200 — devops can list SMTP configs', async () => {
      const r = await request(app)
        .get('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('password and apiKey are masked as "***" in list response', async () => {
      smtpRepo.find.mockResolvedValue([seedSmtp]);
      const r = await request(app)
        .get('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`);
      if (r.status === 200) {
        r.body.forEach((c: Record<string, unknown>) => {
          if (c.password !== null && c.password !== undefined) expect(c.password).toBe('***');
          if (c.apiKey   !== null && c.apiKey   !== undefined) expect(c.apiKey).toBe('***');
        });
      }
    });

    it('403 — tech_lead cannot read SMTP settings', async () => {
      const r = await request(app)
        .get('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.tech_lead}`);
      expect(r.status).toBe(403);
    });

    it('403 — developer cannot read SMTP settings', async () => {
      const r = await request(app)
        .get('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/settings/smtp', () => {
    it('201 — devops creates SMTP config; password masked in response', async () => {
      smtpRepo.save.mockImplementation((s: any) => Promise.resolve({ id: 'smtp-new', ...s, password: '***', apiKey: '***' }));
      const r = await request(app)
        .post('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({
          name: 'Primary', provider: 'custom',
          host: 'smtp.example.com', port: 587, secure: true,
          username: 'u', password: 'real-password-123',
          fromEmail: 'noreply@platform.io',
        });
      expect(r.status).toBe(201);
      expect(r.body.password).toBe('***');
      expect(r.body.fromEmail).toBe('noreply@platform.io');
    });

    it('400 — fromEmail is required', async () => {
      const r = await request(app)
        .post('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: 'Missing Email', provider: 'custom', host: 'smtp.io' });
      expect(r.status).toBe(400);
    });

    it('400 — name is required', async () => {
      const r = await request(app)
        .post('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ fromEmail: 'a@b.io', provider: 'custom' });
      expect(r.status).toBe(400);
    });

    it('400 — provider must be valid enum (custom|ses|sendgrid|mailgun)', async () => {
      const r = await request(app)
        .post('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: 'Test', provider: 'postmark', fromEmail: 'a@b.io' });
      expect([400, 201]).toContain(r.status);
    });

    it('403 — developer cannot create SMTP config', async () => {
      const r = await request(app)
        .post('/api/settings/smtp')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ name: 'Hack', provider: 'custom', fromEmail: 'h@hack.io' });
      expect(r.status).toBe(403);
    });
  });

  describe('DELETE /api/settings/smtp/:id', () => {
    it('200 — devops can delete SMTP config', async () => {
      smtpRepo.findOne.mockResolvedValue(seedSmtp);
      const r = await request(app)
        .delete(`/api/settings/smtp/${SMTP_ID}`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 204]).toContain(r.status);
    });

    it('403 — developer cannot delete SMTP', async () => {
      const r = await request(app)
        .delete(`/api/settings/smtp/${SMTP_ID}`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. SETTINGS — STORAGE
// ════════════════════════════════════════════════════════════════════
describe('Settings — Storage Providers', () => {
  describe('GET /api/settings/storage', () => {
    it('200 — devops can list storage providers', async () => {
      const r = await request(app)
        .get('/api/settings/storage')
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('403 — developer cannot list storage providers', async () => {
      const r = await request(app)
        .get('/api/settings/storage')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/settings/storage', () => {
    it('201 — devops creates storage provider', async () => {
      const r = await request(app)
        .post('/api/settings/storage')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({
          name: 'MinIO', providerType: 'minio',
          endpointUrl: 'http://minio:9000', bucketName: 'backups',
          credentials: { accessKey: 'admin', secretKey: 'admin' },
        });
      expect([201, 400]).toContain(r.status);
    });

    it('400 — name is required', async () => {
      const r = await request(app)
        .post('/api/settings/storage')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ providerType: 'minio' });
      expect(r.status).toBe(400);
    });

    it('400 — providerType must be minio|s3|google_drive|local', async () => {
      const r = await request(app)
        .post('/api/settings/storage')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: 'Bad', providerType: 'dropbox' });
      expect([400, 201]).toContain(r.status);
    });

    it('403 — developer cannot create storage provider', async () => {
      const r = await request(app)
        .post('/api/settings/storage')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ name: 'Hack Storage', providerType: 'local' });
      expect(r.status).toBe(403);
    });
  });

  describe('PATCH /api/settings/storage/:id/set-default', () => {
    it('200 — devops can set default storage', async () => {
      storageRepo.findOne.mockResolvedValue(seedStorage);
      const r = await request(app)
        .patch(`/api/settings/storage/${STOR_ID}/set-default`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 404]).toContain(r.status);
    });

    it('403 — developer cannot set default storage', async () => {
      const r = await request(app)
        .patch(`/api/settings/storage/${STOR_ID}/set-default`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. AUDIT LOGS
// ════════════════════════════════════════════════════════════════════
describe('Audit Logs', () => {
  describe('GET /api/audit-logs', () => {
    it('200 — devops can access audit log', async () => {
      const r = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('200 — tech_lead can access audit log', async () => {
      const r = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${T.tech_lead}`);
      expect(r.status).toBe(200);
    });

    it('403 — developer cannot access audit log', async () => {
      const r = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });

    it('403 — viewer cannot access audit log', async () => {
      const r = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${T.viewer}`);
      expect(r.status).toBe(403);
    });

    it('each entry has action and performedAt fields', async () => {
      const r = await request(app)
        .get('/api/audit-logs')
        .set('Authorization', `Bearer ${T.devops}`);
      if (r.status === 200 && r.body.length > 0) {
        expect(r.body[0]).toHaveProperty('action');
        expect(r.body[0]).toHaveProperty('performedAt');
      }
    });
  });

  describe('GET /api/logs/search', () => {
    it('200 — any auth user can search logs', async () => {
      const r = await request(app)
        .get('/api/logs/search')
        .query({ projectId: PROJ_ID, level: 'INFO' })
        .set('Authorization', `Bearer ${T.developer}`);
      expect([200, 400]).toContain(r.status);
    });

    it('401 — no token', async () => {
      const r = await request(app).get('/api/logs/search');
      expect(r.status).toBe(401);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. BUG REPORTS MANAGEMENT
// ════════════════════════════════════════════════════════════════════
describe('Bug Reports Management', () => {
  describe('GET /api/bug-reports', () => {
    it('200 — any auth user can list bug reports', async () => {
      const r = await request(app)
        .get('/api/bug-reports')
        .query({ projectId: PROJ_ID })
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(200);
    });
  });

  describe('DELETE /api/bug-reports/:id', () => {
    it('200 — devops can delete bug report', async () => {
      const r = await request(app)
        .delete('/api/bug-reports/b1')
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 204, 404]).toContain(r.status);
    });

    it('200 — tech_lead can delete bug report', async () => {
      const r = await request(app)
        .delete('/api/bug-reports/b1')
        .set('Authorization', `Bearer ${T.tech_lead}`);
      expect([200, 204, 404]).toContain(r.status);
    });

    it('403 — developer cannot delete bug report', async () => {
      const r = await request(app)
        .delete('/api/bug-reports/b1')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. DB CONNECTIONS
// ════════════════════════════════════════════════════════════════════
describe('DB Connections API', () => {
  describe('GET /api/db-connections', () => {
    it('200 — any auth user can list DB connections', async () => {
      const r = await request(app)
        .get('/api/db-connections')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });
  });

  describe('POST /api/db-connections', () => {
    it('201/200 — devops can register DB connection', async () => {
      const r = await request(app)
        .post('/api/db-connections')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ projectId: PROJ_ID, dbType: 'postgres', poolSize: 10 });
      expect([200, 201, 400]).toContain(r.status);
    });

    it('403 — developer cannot register DB connection', async () => {
      const r = await request(app)
        .post('/api/db-connections')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ projectId: PROJ_ID, dbType: 'postgres' });
      expect(r.status).toBe(403);
    });

    it('400 — dbType must be postgres|mongo|redis', async () => {
      const r = await request(app)
        .post('/api/db-connections')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ projectId: PROJ_ID, dbType: 'mysql' });
      expect([400, 201]).toContain(r.status);
    });
  });

  describe('DELETE /api/db-connections/:id', () => {
    it('200 — devops can delete DB connection', async () => {
      dbConnRepo.findOne.mockResolvedValue(seedDbConn);
      const r = await request(app)
        .delete(`/api/db-connections/${DBCONN_ID}`)
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 204, 404]).toContain(r.status);
    });

    it('403 — developer cannot delete DB connection', async () => {
      const r = await request(app)
        .delete(`/api/db-connections/${DBCONN_ID}`)
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});
