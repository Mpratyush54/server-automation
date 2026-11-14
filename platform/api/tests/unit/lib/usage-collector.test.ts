import 'reflect-metadata';
import { MemoryRepo } from '../../helpers/memory-repo';
import { collectUsageDay, evaluateMonthlyQuotaAlerts } from '../../../src/lib/usage-collector';
import { GiB } from '../../../src/lib/usage-metrics';
import { setAlertEventTestHook } from '../../../src/lib/alert-events';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}

const query = jest.fn(async (..._args: unknown[]) => [] as any[]);

jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({
    getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name),
    query: (sql: string, params?: unknown[]) => query(sql, params),
  }),
}));

const A = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';

describe('usage collector', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockRepos)) delete mockRepos[k];
    query.mockReset().mockResolvedValue([]);
    setAlertEventTestHook(null);
    mockRepo('Environment').rows.push({
      id: ENV, projectId: A, name: 'production', namespace: 'shop-production-abc',
      domain: 'shop-production-abc.example.com', isActive: true,
    });
    mockRepo('File').rows.push({
      id: 'f1', projectId: A, size: 2 * GiB, isDeleted: false,
    });
  });

  afterEach(() => setAlertEventTestHook(null));

  it('writes daily rollups from fixed Prometheus vectors', async () => {
    const ds = await (await import('../../../src/config/database')).getDb();
    const result = await collectUsageDay(ds as any, '2026-03-10', {
      fetchVectors: async () => ({
        cpuByNs: new Map([['shop-production-abc', 7200]]), // 2 core-hours
        memoryBytesByNs: new Map([['shop-production-abc', GiB]]),
        pvcBytesByNs: new Map([['shop-production-abc', 5 * GiB]]),
        ingressBytesByHost: new Map([['shop-production-abc.example.com', 3 * GiB]]),
      }),
      emit: async () => {},
    });
    expect(result).toMatchObject({ day: '2026-03-10', rollups: 1, environments: 1 });
    const row = mockRepo('UsageDailyRollup').rows[0];
    expect(row).toMatchObject({
      projectId: A,
      environmentId: ENV,
      day: '2026-03-10',
      cpuCoreHours: 2,
      memoryGbHours: 24,
      pvcStorageGb: 5,
      objectStorageGb: 2,
      ingressBandwidthGb: 3,
    });
  });

  it('emits quota alerts at 80% for month-to-date usage', async () => {
    const events: any[] = [];
    mockRepo('UsageQuota').rows.push({
      id: 'q1', projectId: A, cpuCoreHours: 10, memoryGbHours: null, storageGb: null,
      bandwidthGb: null, buildMinutes: null, resourceQuota: null, alertsEnabled: true,
    });
    mockRepo('UsageDailyRollup').rows.push({
      id: 'r1', projectId: A, environmentId: ENV, day: '2026-03-05',
      cpuCoreHours: 8, memoryGbHours: 0, pvcStorageGb: 0, objectStorageGb: 0,
      ingressBandwidthGb: 0, buildMinutes: 0,
    });
    const ds = await (await import('../../../src/config/database')).getDb();
    const n = await evaluateMonthlyQuotaAlerts(ds as any, '2026-03-10', async (e) => { events.push(e); });
    expect(n).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.source === 'usage' && e.severity === 'warning' && e.status === 'firing')).toBe(true);
  });

  it('skips cleanly when Prometheus is unavailable', async () => {
    const ds = await (await import('../../../src/config/database')).getDb();
    const result = await collectUsageDay(ds as any, '2026-03-10', {
      fetchVectors: async () => { throw new Error('prometheus down'); },
    });
    expect(result.skipped).toMatch(/prometheus/);
    expect(mockRepos['UsageDailyRollup']?.rows || []).toHaveLength(0);
  });
});
