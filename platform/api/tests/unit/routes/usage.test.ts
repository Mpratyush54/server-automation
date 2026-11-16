/**
 * Usage routes (#57): auth, project access, CSV export, settings and quota writes.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}

jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));

jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, res: any, next: any) => {
    if (!req.get('x-user')) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: req.get('x-user'), role: req.get('x-role') || 'developer' };
    next();
  },
  expressRequireRole: (roles: string[]) => (req: any, res: any, next: any) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}));

jest.mock('../../../src/lib/usage-collector', () => ({
  applyProjectResourceQuota: jest.fn(async () => {}),
  getOrCreateUsageSettings: async () => {
    const repo = mockRepo('UsageSettings');
    if (!repo.rows[0]) {
      repo.rows.push({
        id: 's1', perCoreHour: 0.04, perGbHourMemory: 0.005, perGbMonthStorage: 0.02,
        perGbBandwidth: 0.09, perBuildMinute: 0.002, monthlyServerCost: 0, currency: 'USD',
      });
    }
    return repo.rows[0];
  },
  loadUsagePrices: async () => ({
    perCoreHour: 0.04, perGbHourMemory: 0.005, perGbMonthStorage: 0.02,
    perGbBandwidth: 0.09, perBuildMinute: 0.002, monthlyServerCost: 0, currency: 'USD',
  }),
}));

import usageRoutes from '../../../src/routes/usage';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DEV = '33333333-0000-4000-8000-000000000001';
const ADMIN = '33333333-0000-4000-8000-000000000003';

function app() {
  const a = express();
  a.use(express.json());
  a.use(usageRoutes);
  return a;
}
const as = (r: request.Test, user: string, role = 'developer') => r.set('x-user', user).set('x-role', role);

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockRepo('Project').rows.push({ id: A, name: 'shop', isActive: true }, { id: B, name: 'bank', isActive: true });
  mockRepo('ProjectMember').rows.push({ id: 'm1', projectId: A, userId: DEV, role: 'developer' });
  mockRepo('UsageDailyRollup').rows.push({
    id: 'r1', projectId: A, environmentId: 'e1', environmentName: 'production',
    namespace: 'shop-prod', day: '2026-03-01',
    cpuCoreHours: 2, memoryGbHours: 10, pvcStorageGb: 1, objectStorageGb: 0.5,
    ingressBandwidthGb: 0.2, buildMinutes: 3,
  });
});

describe('usage routes', () => {
  it('requires auth and project membership for project usage', async () => {
    await as(request(app()).get(`/projects/${A}/usage`), DEV).expect(200);
    await request(app()).get(`/projects/${A}/usage`).expect(401);
    await as(request(app()).get(`/projects/${B}/usage`), DEV).expect(403);
  });

  it('returns daily rows, totals and estimated cost', async () => {
    const res = await as(request(app()).get(`/projects/${A}/usage?from=2026-03-01&to=2026-03-31`), DEV).expect(200);
    expect(res.body.totals.cpuCoreHours).toBe(2);
    expect(res.body.cost.total).toBeGreaterThan(0);
    expect(res.body.daily).toHaveLength(1);
    expect(res.body.quotaBars.cpuCoreHours).toBeDefined();
  });

  it('exports CSV for a project', async () => {
    const res = await as(request(app()).get(`/projects/${A}/usage/export.csv?from=2026-03-01&to=2026-03-31`), DEV).expect(200);
    expect(res.headers['content-type']).toMatch(/csv/);
    expect(res.text).toContain('cpuCoreHours');
    expect(res.text).toContain('shop');
  });

  it('restricts fleet usage and settings to devops/admin', async () => {
    await as(request(app()).get('/usage'), DEV).expect(403);
    const ok = await as(request(app()).get('/usage?from=2026-03-01&to=2026-03-31'), ADMIN, 'devops').expect(200);
    expect(ok.body.projects.length).toBeGreaterThanOrEqual(1);

    await as(request(app()).get('/usage/settings'), DEV).expect(403);
    const settings = await as(request(app()).get('/usage/settings'), ADMIN, 'admin').expect(200);
    expect(settings.body.currency).toBe('USD');

    const saved = await as(request(app()).put('/usage/settings'), ADMIN, 'admin')
      .send({ perCoreHour: 0.08, monthlyServerCost: 120, currency: 'usd' })
      .expect(200);
    expect(saved.body.perCoreHour).toBe(0.08);
    expect(saved.body.monthlyServerCost).toBe(120);
    expect(saved.body.currency).toBe('USD');
  });

  it('lets devops update project quotas', async () => {
    await as(request(app()).put(`/projects/${A}/usage/quota`), DEV)
      .send({ cpuCoreHours: 100 })
      .expect(403);
    const res = await as(request(app()).put(`/projects/${A}/usage/quota`), ADMIN, 'devops')
      .send({ cpuCoreHours: 100, resourceQuota: { 'requests.cpu': '2' }, alertsEnabled: true })
      .expect(200);
    expect(res.body.cpuCoreHours).toBe(100);
    expect(res.body.resourceQuota['requests.cpu']).toBe('2');
  });
});
