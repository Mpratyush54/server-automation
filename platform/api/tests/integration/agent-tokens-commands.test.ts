/**
 * Agent tokens + guarded command execution integration tests.
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

const bcrypt = require('bcryptjs');
const TEST_PASSWORD = 'TestPass123';
const TEST_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

const ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@pratyushes.dev',
  username: 'admin',
  name: 'Admin',
  role: 'admin',
  roleId: null,
  isActive: true,
  passwordHash: TEST_HASH,
};

const DEVELOPER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'john@pratyushes.dev',
  username: 'john',
  name: 'John Dev',
  role: 'developer',
  roleId: null,
  isActive: true,
  passwordHash: TEST_HASH,
};

const RAW_AGENT = 'plat_agent_aabbccddeeff00112233445566778899';
const AGENT_PREFIX = RAW_AGENT.slice(0, 20);
const AGENT_HASH = bcrypt.hashSync(RAW_AGENT, 4);

let agentRecord: any = {
  id: 'a1111111-1111-1111-1111-111111111111',
  name: 'mcp-agent',
  tokenPrefix: AGENT_PREFIX,
  tokenHash: AGENT_HASH,
  scopes: ['commands:validate', 'commands:execute', 'projects:read', 'logs:read', 'cluster:read', 'audit:read', 'bootstrap:read'],
  createdByUserId: ADMIN.id,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const approvals = new Map<string, any>();

const mockUserRepo = {
  findOne: jest.fn(),
  find: jest.fn().mockResolvedValue([ADMIN, DEVELOPER]),
  save: jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
  create: jest.fn().mockImplementation((d: any) => ({ id: 'new-user', ...d })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockAgentTokenRepo = {
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
};

const mockApprovalRepo = {
  findOne: jest.fn(),
  find: jest.fn(),
  save: jest.fn(),
  create: jest.fn(),
};

const mockRoleRepo = {
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
};

const mockAuditRepo = {
  create: jest.fn().mockImplementation((d: any) => d),
  save: jest.fn().mockResolvedValue({}),
  find: jest.fn().mockResolvedValue([]),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity: any) => {
    const name = typeof entity === 'string' ? entity : entity?.name;
    if (name === 'User') return mockUserRepo;
    if (name === 'AgentToken') return mockAgentTokenRepo;
    if (name === 'AgentCommandApproval') return mockApprovalRepo;
    if (name === 'Role') return mockRoleRepo;
    if (name === 'AuditLog') return mockAuditRepo;
    return {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    };
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue(mockDataSource),
}));

jest.mock('../../src/schemas/Log', () => ({ LogModel: { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/ApiMetric', () => ({ ApiMetricModel: { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/BugReport', () => ({ BugReportModel: { create: jest.fn().mockResolvedValue({ _id: 'bug-1' }) } }));
jest.mock('../../src/schemas/ErrorDoc', () => ({ ErrorDocModel: { findOneAndUpdate: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/SdkEvent', () => ({ SdkEventModel: { create: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/MetricsRaw', () => ({ MetricsRawModel: { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/FeatureFlag', () => ({ FeatureFlagModel: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import apiRouter from '../../src/routes/api';

const JWT_SECRET = 'plat-super-secret-key';
const sign = (user: Record<string, unknown>) => jwt.sign(user, JWT_SECRET, { expiresIn: '2h' });
const adminJwt = sign({ id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, role: 'admin' });
const developerJwt = sign({ id: DEVELOPER.id, email: DEVELOPER.email, name: DEVELOPER.name, role: 'developer' });

let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.AGENT_COMMAND_DRY_RUN = '1';
  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
  approvals.clear();
  agentRecord = {
    ...agentRecord,
    isActive: true,
    revokedAt: null,
    tokenHash: AGENT_HASH,
    tokenPrefix: AGENT_PREFIX,
    scopes: ['commands:validate', 'commands:execute', 'projects:read', 'logs:read', 'cluster:read', 'audit:read', 'bootstrap:read'],
  };

  mockUserRepo.findOne.mockImplementation(({ where }: any) => {
    const { email, id, username } = where || {};
    if (id === ADMIN.id || email === ADMIN.email || username === ADMIN.username) return Promise.resolve(ADMIN);
    if (id === DEVELOPER.id || email === DEVELOPER.email || username === DEVELOPER.username) return Promise.resolve(DEVELOPER);
    return Promise.resolve(null);
  });

  mockAgentTokenRepo.findOne.mockImplementation(({ where }: any) => {
    if (where?.tokenPrefix === AGENT_PREFIX || where?.id === agentRecord.id) {
      return Promise.resolve({ ...agentRecord });
    }
    return Promise.resolve(null);
  });
  mockAgentTokenRepo.find.mockResolvedValue([{ ...agentRecord }]);
  mockAgentTokenRepo.create.mockImplementation((d: any) => ({ id: 'new-agent-token', createdAt: new Date(), updatedAt: new Date(), ...d }));
  mockAgentTokenRepo.save.mockImplementation((d: any) => {
    if (d.tokenPrefix === AGENT_PREFIX || d.id === agentRecord.id) {
      agentRecord = { ...agentRecord, ...d };
    }
    return Promise.resolve(d);
  });

  mockApprovalRepo.create.mockImplementation((d: any) => ({
    id: `apr-${approvals.size + 1}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...d,
  }));
  mockApprovalRepo.save.mockImplementation((d: any) => {
    const id = d.id || `apr-${approvals.size + 1}`;
    const saved = { ...d, id };
    approvals.set(id, saved);
    return Promise.resolve(saved);
  });
  mockApprovalRepo.findOne.mockImplementation(({ where }: any) => {
    if (where?.id) return Promise.resolve(approvals.get(where.id) || null);
    if (where?.status === 'pending' && where?.command) {
      for (const a of approvals.values()) {
        if (a.status === 'pending' && a.command === where.command) return Promise.resolve(a);
      }
    }
    return Promise.resolve(null);
  });
  mockApprovalRepo.find.mockImplementation(({ where }: any) => {
    const list = [...approvals.values()];
    if (where?.status) return Promise.resolve(list.filter((a) => a.status === where.status));
    return Promise.resolve(list);
  });
});

describe('GET /api/openapi.json', () => {
  it('returns openapi document without auth', async () => {
    const r = await request(app).get('/api/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\./);
    expect(r.body.paths['/agent-tokens']).toBeDefined();
    expect(r.body.paths['/agent/commands/validate']).toBeDefined();
  });
});

describe('Agent token CRUD', () => {
  it('creates an agent token and returns raw secret once', async () => {
    const r = await request(app)
      .post('/api/agent-tokens')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'cursor-mcp' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^plat_agent_/);
    expect(r.body.name).toBe('cursor-mcp');
    expect(r.body.scopes.length).toBeGreaterThan(0);
    expect(r.body.tokenHash).toBeUndefined();
  });

  it('rejects developer creating tokens', async () => {
    const r = await request(app)
      .post('/api/agent-tokens')
      .set('Authorization', `Bearer ${developerJwt}`)
      .send({ name: 'nope' });
    expect(r.status).toBe(403);
  });

  it('lists tokens for admin', async () => {
    const r = await request(app)
      .get('/api/agent-tokens')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it('GET /agent-tokens/me works with agent token', async () => {
    const r = await request(app)
      .get('/api/agent-tokens/me')
      .set('Authorization', `Bearer ${RAW_AGENT}`);
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('agent_token');
    expect(r.body.id).toBe(agentRecord.id);
  });

  it('rejects invalid agent token', async () => {
    const r = await request(app)
      .get('/api/agent-tokens/me')
      .set('Authorization', 'Bearer plat_agent_thisisinvalid0000000000000000');
    expect(r.status).toBe(401);
  });
});

describe('Agent commands', () => {
  it('validates a read-only command with agent token', async () => {
    const r = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl get pods' });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(true);
    expect(r.body.riskLevel).toBe('read');
    expect(r.body.requiresHumanApproval).toBe(false);
  });

  it('executes read-only command in dry-run with confirm not required', async () => {
    const r = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl get pods' });
    expect(r.status).toBe(200);
    expect(r.body.result.ok).toBe(true);
    expect(r.body.result.dryRun).toBe(true);
  });

  it('requires confirm+reason for mutating commands', async () => {
    const missing = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl rollout restart deployment/api' });
    expect(missing.status).toBe(400);

    const withConfirm = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl rollout restart deployment/api', confirm: true });
    expect(withConfirm.status).toBe(400);
    expect(withConfirm.body.error).toMatch(/reason/i);

    const ok = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({
        command: 'kubectl rollout restart deployment/api',
        confirm: true,
        reason: 'bounce after config change',
      });
    expect(ok.status).toBe(200);
    expect(ok.body.result.ok).toBe(true);
  });

  it('creates pending approval for destructive commands and blocks agent self-approve', async () => {
    const v = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl delete pod x -n default' });
    expect(v.status).toBe(200);
    expect(v.body.requiresHumanApproval).toBe(true);
    expect(v.body.approvalId).toBeTruthy();

    const pendingAsAgent = await request(app)
      .get('/api/agent/commands/pending')
      .set('Authorization', `Bearer ${RAW_AGENT}`);
    expect(pendingAsAgent.status).toBe(403);

    const approveAsAgent = await request(app)
      .post(`/api/agent/commands/${v.body.approvalId}/approve`)
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({});
    expect(approveAsAgent.status).toBe(403);

    const execWithoutApproval = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({
        command: 'kubectl delete pod x -n default',
        confirm: true,
        reason: 'cleanup',
      });
    expect(execWithoutApproval.status).toBe(403);

    const approveAsHuman = await request(app)
      .post(`/api/agent/commands/${v.body.approvalId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(approveAsHuman.status).toBe(200);
    expect(approveAsHuman.body.status).toBe('approved');

    const exec = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({
        command: 'kubectl delete pod x -n default',
        confirm: true,
        reason: 'cleanup',
        approvalId: v.body.approvalId,
      });
    expect(exec.status).toBe(200);
    expect(exec.body.result.ok).toBe(true);
  });

  it('allows human to reject pending commands', async () => {
    const v = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl delete pod y -n default' });
    expect(v.body.approvalId).toBeTruthy();

    const rejected = await request(app)
      .post(`/api/agent/commands/${v.body.approvalId}/reject`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ reason: 'too risky' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');
  });

  it('denies banned commands at validate', async () => {
    const r = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'rm -rf /' });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.riskLevel).toBe('denied');
  });
});
