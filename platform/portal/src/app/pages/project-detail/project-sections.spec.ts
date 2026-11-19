import {
  PROJECT_SECTIONS, anchorForTab, currentDeployment, deploymentStatus, projectStatus, sectionForTab, statusClass,
} from './project-sections';

describe('project sections (#185)', () => {
  describe('sectionForTab', () => {
    const cases: [string | null | undefined, string][] = [
      ['deployments', 'deployments'], ['gitops', 'deployments'], ['environments', 'deployments'],
      ['environment', 'configuration'], ['config', 'configuration'], ['secrets', 'configuration'],
      ['metrics', 'monitoring'], ['api-metrics', 'monitoring'], ['logs', 'monitoring'],
      ['storage', 'data'], ['databases', 'data'],
      ['access', 'settings'], ['sdk-tokens', 'settings'], ['privacy', 'settings'],
      ['overview', 'overview'], ['configuration', 'configuration'], ['data', 'data'],
      ['monitoring', 'monitoring'], ['settings', 'settings'],
      ['Deployments', 'deployments'], [' logs ', 'monitoring'],
      ['unknown', 'overview'], ['', 'overview'], [null, 'overview'], [undefined, 'overview'], ['__proto__', 'overview'],
    ];
    for (const [tab, section] of cases) {
      it(`${JSON.stringify(tab)} -> ${section}`, () => expect(sectionForTab(tab)).toBe(section as any));
    }
    it('section ids are listed in navigation order', () => {
      expect(PROJECT_SECTIONS.map((s) => s.id)).toEqual(['overview', 'deployments', 'configuration', 'data', 'monitoring', 'settings']);
    });
  });

  it('anchorForTab points old tabs at their panel', () => {
    expect(anchorForTab('sdk-tokens')).toBe('sdk-tokens');
    expect(anchorForTab('api-metrics')).toBe('api-latency');
    expect(anchorForTab('gitops')).toBe('gitops');
    expect(anchorForTab('deployments')).toBeNull();
    expect(anchorForTab(null)).toBeNull();
  });

  it('projectStatus: active unless being deleted or deleted', () => {
    expect(projectStatus({ isActive: true })).toEqual({ label: 'Active', tone: 'ok' });
    expect(projectStatus({})).toEqual({ label: 'Active', tone: 'ok' });
    expect(projectStatus({ isActive: false })).toEqual({ label: 'Being deleted', tone: 'warn' });
    expect(projectStatus({ isActive: true, deletedAt: '2026-01-01' }).label).toBe('Deleted');
  });

  it('deploymentStatus maps every API status', () => {
    expect(deploymentStatus('deployed')).toEqual({ label: 'Deployed', tone: 'ok' });
    expect(deploymentStatus('active').tone).toBe('ok');
    expect(deploymentStatus('building').tone).toBe('info');
    expect(deploymentStatus('failed')).toEqual({ label: 'Failed', tone: 'down' });
    expect(deploymentStatus('rolled_back').label).toBe('Rolled back');
    expect(deploymentStatus('expired').tone).toBe('neutral');
    expect(deploymentStatus(undefined).label).toBe('Unknown');
    expect(statusClass('ok')).toBe('status status-ok');
    expect(statusClass('neutral')).toBe('status');
  });

  it('currentDeployment prefers the newest live deployment, else the newest attempt', () => {
    const deps = [
      { id: 'a', environmentId: 'e1', status: 'deployed', deployedAt: '2026-01-01T00:00:00Z' },
      { id: 'b', environmentId: 'e1', status: 'failed', createdAt: '2026-01-03T00:00:00Z' },
      { id: 'c', environmentId: 'e1', status: 'deployed', deployedAt: '2026-01-02T00:00:00Z' },
      { id: 'd', environmentId: 'e2', status: 'failed', createdAt: '2026-01-04T00:00:00Z' },
    ];
    expect(currentDeployment(deps, 'e1').id).toBe('c');
    expect(currentDeployment(deps, 'e2').id).toBe('d');
    expect(currentDeployment(deps, 'e3')).toBeNull();
  });
});

describe('releases links from alerts', () => {
  it('opens Deployments at the releases panel', () => {
    expect(sectionForTab('releases')).toBe('deployments');
  });
});
