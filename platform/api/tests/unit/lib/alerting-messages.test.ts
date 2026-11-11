/** Alert notification content: resolution titles and Teams colours. */
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));
jest.mock('../../../src/lib/notify', () => ({ notifyUser: jest.fn(async () => {}) }));

import { processAlertEvent, messageFor } from '../../../src/lib/alerting-engine';
import { teamsColor, teamsPayload } from '../../../src/lib/alerting-channels';
import { buildAlertEvent } from '../../../src/lib/synthetic-scheduler';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-messages';

const PID = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-03-01T10:00:00Z');

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockRepo('Project').rows.push({ id: PID, name: 'shop' });
});

describe('resolution title', () => {
  it('uses the recovery title sent by the source, not the firing title', async () => {
    const check = { id: 'c1', projectId: PID, name: 'api', type: 'http', environmentId: null } as any;
    const firing = buildAlertEvent(check, { status: 'firing', severity: 'critical' }, { error: 'timeout', consecutiveFailures: 1, result: 'fail' });
    const resolved = buildAlertEvent(check, { status: 'resolved', severity: 'info' }, { error: null, consecutiveFailures: 0, result: 'pass' });
    await processAlertEvent(firing, T0);
    await processAlertEvent(resolved, new Date(T0.getTime() + 60_000));
    const inc = mockRepo('AlertIncident').rows[0];
    expect(inc.title).toMatch(/is failing \(1 consecutive failures\)/);
    expect(messageFor(inc, 'resolved').title).toBe('Synthetic check "api" recovered');
    expect(messageFor(inc, 'firing').title).toBe(inc.title);
  });

  it('keeps the incident title when the resolve event repeats it or has none', async () => {
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'CPU high' }, T0);
    await processAlertEvent({ projectId: PID, source: 'monitor', severity: 'critical', dedupeKey: 'm1', title: 'CPU high', status: 'resolved' }, T0);
    expect(messageFor(mockRepo('AlertIncident').rows[0], 'resolved').title).toBe('CPU high');
  });
});

describe('Teams colours', () => {
  it('info and test messages use the neutral accent colour', () => {
    expect(teamsColor({ event: 'test', severity: 'info' })).toBe('Accent');
    expect(teamsColor({ event: 'firing', severity: 'info' })).toBe('Accent');
    expect(teamsColor({ event: 'firing', severity: 'warning' })).toBe('Warning');
    expect(teamsColor({ event: 'firing', severity: 'critical' })).toBe('Attention');
    expect(teamsColor({ event: 'resolved', severity: 'critical' })).toBe('Good');
    const card = teamsPayload({ event: 'test', incidentId: 'x', projectId: PID, projectName: 'shop', title: 't', severity: 'info', source: 'monitor', dedupeKey: 'k', status: 'firing', startedAt: T0.toISOString() } as any);
    const body = card.attachments[0].content.body;
    expect(body[0].color).toBe('Accent');
    expect(JSON.stringify(body)).toContain('"value":"shop"');
  });
});
