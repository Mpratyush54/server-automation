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

const TECH_LEAD = {
  id: '22222222-2222-2222-2222-222222222222',
  email: 'lead@pratyushes.dev',
  username: 'lead',
  name: 'Tech Lead',
  role: 'tech_lead',
  roleId: null,
  isActive: true,
  passwordHash: TEST_HASH,
};

const RAW_AGENT_2 = 'plat_agent_99887766554433221100ffeeddccbbaa';
const AGENT_PREFIX_2 = RAW_AGENT_2.slice(0, 20);
const AGENT_HASH_2 = bcrypt.hashSync(RAW_AGENT_2, 4);

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
  update: jest.fn(),
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
import { loadOpenApiJson } from '../../src/lib/openapi-spec';

// Same as server.ts at boot: build the spec once while the module loads (like the app
// imports above), so the request test measures the cached response, not the YAML parse.
loadOpenApiJson();

const JWT_SECRET = 'plat-super-secret-key';
const sign = (user: Record<string, unknown>) => jwt.sign(user, JWT_SECRET, { expiresIn: '2h' });
// Agent-token creation needs a recent second factor (#24): this admin session just passed one.
const adminJwt = sign({ id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, role: 'admin', amr: ['pwd', 'otp', 'mfa'], auth_time: Math.floor(Date.now() / 1000) });
const adminNoMfaJwt = sign({ id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, role: 'admin', amr: ['pwd'], auth_time: Math.floor(Date.now() / 1000) });
const developerJwt = sign({ id: DEVELOPER.id, email: DEVELOPER.email, name: DEVELOPER.name, role: 'developer' });
const techLeadJwt = sign({ id: TECH_LEAD.id, email: TECH_LEAD.email, name: TECH_LEAD.name, role: 'tech_lead' });

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
    if (id === TECH_LEAD.id) return Promise.resolve(TECH_LEAD);
    return Promise.resolve(null);
  });

  mockAgentTokenRepo.findOne.mockImplementation(({ where }: any) => {
    if (where?.tokenPrefix === AGENT_PREFIX || where?.id === agentRecord.id) {
      return Promise.resolve({ ...agentRecord });
    }
    if (where?.tokenPrefix === AGENT_PREFIX_2) {
      return Promise.resolve({ ...agentRecord, id: 'a2222222-2222-2222-2222-222222222222', name: 'other-agent', tokenPrefix: AGENT_PREFIX_2, tokenHash: AGENT_HASH_2 });
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
  // Conditional UPDATE ... WHERE semantics (every criteria key must match), like TypeORM's repo.update.
  mockApprovalRepo.update.mockImplementation((criteria: any, patch: any) => {
    const row = approvals.get(criteria.id);
    if (!row || Object.keys(criteria).some((k) => row[k] !== criteria[k])) return Promise.resolve({ affected: 0 });
    approvals.set(row.id, { ...row, ...patch });
    return Promise.resolve({ affected: 1 });
  });
  mockApprovalRepo.findOne.mockImplementation(({ where }: any) => {
    if (where?.id) {
      const row = approvals.get(where.id);
      return Promise.resolve(row ? { ...row } : null);
    }
    if (where?.status === 'pending' && where?.command) {
      for (const a of approvals.values()) {
        if (a.status !== 'pending' || a.command !== where.command) continue;
        if ('requestedByAgentTokenId' in where && a.requestedByAgentTokenId !== where.requestedByAgentTokenId) continue;
        if ('requestedByUserId' in where && a.requestedByUserId !== where.requestedByUserId) continue;
        return Promise.resolve({ ...a });
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

  it('requires a recent second factor to create a token (#24)', async () => {
    const r = await request(app)
      .post('/api/agent-tokens')
      .set('Authorization', `Bearer ${adminNoMfaJwt}`)
      .send({ name: 'needs-step-up' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('step_up_required');
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

  it('denies the env/cat read-tier bypasses at validate and execute (H1)', async () => {
    for (const command of ['env sh -c "id"', 'cat /var/run/secrets/kubernetes.io/serviceaccount/token', 'printenv JWT_SECRET']) {
      const v = await request(app)
        .post('/api/agent/commands/validate')
        .set('Authorization', `Bearer ${RAW_AGENT}`)
        .send({ command });
      expect(v.status).toBe(200);
      expect(v.body.allowed).toBe(false);
      const e = await request(app)
        .post('/api/agent/commands/execute')
        .set('Authorization', `Bearer ${RAW_AGENT}`)
        .send({ command, confirm: true, reason: 'x' });
      expect(e.status).toBe(403);
    }
  });

  it('requires human approval for reading secret values (H1)', async () => {
    const e = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl get secret db -o yaml', confirm: true, reason: 'debug' });
    expect(e.status).toBe(403);
    expect(e.body.error).toMatch(/approv/i);
  });

  it('forbids developer/tech_lead humans from executing commands (H2)', async () => {
    for (const token of [developerJwt, techLeadJwt]) {
      const r = await request(app)
        .post('/api/agent/commands/execute')
        .set('Authorization', `Bearer ${token}`)
        .send({ command: 'kubectl get pods' });
      expect(r.status).toBe(403);
    }
    const dev = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${developerJwt}`)
      .send({ command: 'kubectl delete pod x' });
    expect(dev.status).toBe(403);
    expect(approvals.size).toBe(0);
  });

  it('forbids tech_lead from approving or rejecting (H2)', async () => {
    const v = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command: 'kubectl delete pod z -n default' });
    for (const action of ['approve', 'reject']) {
      const r = await request(app)
        .post(`/api/agent/commands/${v.body.approvalId}/${action}`)
        .set('Authorization', `Bearer ${techLeadJwt}`)
        .send({});
      expect(r.status).toBe(403);
    }
    expect(approvals.get(v.body.approvalId).status).toBe('pending');
  });

  it('lets an admin human execute a read command', async () => {
    const r = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ command: 'kubectl get pods' });
    expect(r.status).toBe(200);
  });

  it('binds approvals to the requesting token and executes them once (L3)', async () => {
    const command = 'kubectl delete pod once -n default';
    const v = await request(app)
      .post('/api/agent/commands/validate')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send({ command });
    await request(app)
      .post(`/api/agent/commands/${v.body.approvalId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(200);

    const body = { command, confirm: true, reason: 'cleanup', approvalId: v.body.approvalId };
    const stolen = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT_2}`)
      .send(body);
    expect(stolen.status).toBe(403);
    expect(approvals.get(v.body.approvalId).status).toBe('approved');

    const [a, b] = await Promise.all([
      request(app).post('/api/agent/commands/execute').set('Authorization', `Bearer ${RAW_AGENT}`).send(body),
      request(app).post('/api/agent/commands/execute').set('Authorization', `Bearer ${RAW_AGENT}`).send(body),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    expect(approvals.get(v.body.approvalId).status).toBe('executed');

    // Simulate the race window: a request that read the row while it was still 'approved'
    // must lose the conditional claim instead of executing a second time.
    const staleRow = { ...approvals.get(v.body.approvalId), status: 'approved' };
    mockApprovalRepo.findOne.mockImplementationOnce(() => Promise.resolve(staleRow));
    const raced = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send(body);
    expect(raced.status).toBe(409);

    const again = await request(app)
      .post('/api/agent/commands/execute')
      .set('Authorization', `Bearer ${RAW_AGENT}`)
      .send(body);
    expect(again.status).toBe(403);
  });

  it("does not reuse another token's pending approval at validate", async () => {
    const command = 'kubectl delete pod shared -n default';
    const v1 = await request(app).post('/api/agent/commands/validate').set('Authorization', `Bearer ${RAW_AGENT}`).send({ command });
    const v2 = await request(app).post('/api/agent/commands/validate').set('Authorization', `Bearer ${RAW_AGENT_2}`).send({ command });
    expect(v1.body.approvalId).toBeTruthy();
    expect(v2.body.approvalId).toBeTruthy();
    expect(v2.body.approvalId).not.toBe(v1.body.approvalId);
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
