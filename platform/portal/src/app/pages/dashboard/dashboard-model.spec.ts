import { buildActivity, buildApps, buildAttention, buildChecklist, timeAgo } from './dashboard-model';

describe('dashboard model', () => {
  const at = (min: number) => new Date(Date.now() - min * 60000).toISOString();
  const project = (over: any = {}) => ({
    id: 'p1', name: 'shop', domain: 'shop.example.com', status: 'active',
    environments: [{ id: 'e1', name: 'production' }, { id: 'e2', name: 'staging', domain: 'staging.shop.example.com' }],
    deployments: [] as any[], ...over,
  });

  it('marks an app as needing attention when its latest deployment in any environment failed', () => {
    const apps = buildApps([project({ deployments: [
      { status: 'deployed', environmentId: 'e1', createdAt: at(60) },
      { status: 'failed', environmentId: 'e1', createdAt: at(5) },
      { status: 'deployed', environmentId: 'e2', createdAt: at(10) },
    ] })]);
    expect(apps[0].status).toBe('Needs attention');
    expect(apps[0].envs.map((e) => e.label)).toEqual(['Failed', 'Live']);
    expect(apps[0].url).toBe('https://shop.example.com');
  });

  it('orders apps with problems first', () => {
    const apps = buildApps([
      project({ id: 'a', name: 'alpha', deployments: [{ status: 'deployed', environmentId: 'e1', createdAt: at(1) }] }),
      project({ id: 'b', name: 'beta', deployments: [{ status: 'failed', environmentId: 'e1', createdAt: at(1) }] }),
    ]);
    expect(apps.map((a) => a.name)).toEqual(['beta', 'alpha']);
  });

  it('does not report a passing app or a resolved alert', () => {
    const apps = buildApps([project({ deployments: [{ status: 'deployed', environmentId: 'e1', createdAt: at(1) }] })]);
    const items = buildAttention({ apps, incidents: [{ status: 'resolved', title: 'old' }], backups: null, k8sConnected: true, nodes: [], update: null });
    expect(items).toEqual([]);
  });

  it('summarises several alerts in one line', () => {
    const items = buildAttention({ apps: [], incidents: [
      { status: 'firing', severity: 'critical', title: 'a' }, { status: 'firing', severity: 'warning', title: 'b' },
    ], backups: null, k8sConnected: null, nodes: [], update: null });
    expect(items.length).toBe(1);
    expect(items[0].text).toBe('2 open alerts, 1 critical.');
    expect(items[0].tone).toBe('down');
  });

  it('flags a failed backup and a server that is not ready', () => {
    const items = buildAttention({ apps: [], incidents: [], k8sConnected: true, update: null,
      nodes: [{ name: 'node-2', status: 'NotReady' }],
      backups: [{ operation: 'backup', status: { success: false, finishedAt: at(30) } }] });
    expect(items.map((i) => i.text)).toEqual(['Server node-2 is not ready.', 'The last backup failed.']);
  });

  it('warns when backups are stored only on this server and links to the docs', () => {
    const items = buildAttention({ apps: [], incidents: [], k8sConnected: true, nodes: [], update: null,
      backups: [{ operation: 'backup', status: { success: true, finishedAt: at(60) }, localOnly: true }, { operation: 'restore-test', status: null }] });
    expect(items).toEqual([{ tone: 'warn', text: 'Backups are stored only on this server.', action: 'Set up off-site backups', link: '/docs/operations/backups' }]);
    const offsite = buildAttention({ apps: [], incidents: [], k8sConnected: true, nodes: [], update: null,
      backups: [{ operation: 'backup', status: { success: true, finishedAt: at(60) }, localOnly: false }] });
    expect(offsite).toEqual([]);
  });

  it('builds a newest-first activity feed with plain sentences', () => {
    const feed = buildActivity([project({ deployments: [
      { status: 'deployed', environmentId: 'e1', createdAt: at(30), version: 'v1', deployedBy: 'ben@example.com', commitMessage: 'Fix tax' },
      { status: 'failed', environmentId: 'e2', createdAt: at(2), version: 'v2' },
    ] })], [{ projectId: 'p1', title: 'Errors up', severity: 'critical', firstSeenAt: at(10) }]);
    expect(feed.map((f) => f.text)).toEqual(['shop staging: v2 failed', 'Alert: Errors up', 'shop production: v1 is live']);
    expect(feed[2].detail).toBe('Fix tax · by ben');
  });

  it('leaves out checklist items whose state is unknown', () => {
    const list = buildChecklist({ projects: [], mfaEnabled: undefined, userCount: null, backupOk: null });
    expect(list.map((c) => c.id)).toEqual(['project', 'repo', 'deploy']);
    expect(list.every((c) => !c.done)).toBeTrue();
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(timeAgo('2026-11-15T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-11-15T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-11-15T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-11-13T12:00:00Z', now)).toBe('2 days ago');
    expect(timeAgo(null, now)).toBe('');
  });
});
