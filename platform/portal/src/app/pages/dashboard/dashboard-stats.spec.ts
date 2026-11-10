import { averageDeployTime, projectGrowth } from './dashboard-stats';

describe('dashboard statistics', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const project = (daysAgo: number) => ({ createdAt: new Date(now - daysAgo * 86400_000).toISOString() });

  it('hides growth without a baseline or complete valid creation dates', () => {
    expect(projectGrowth([], now)).toBeNull();
    expect(projectGrowth([project(1)], now)).toBeNull();
    expect(projectGrowth([project(8), {}], now)).toBeNull();
    expect(projectGrowth([{ createdAt: 'invalid' }], now)).toBeNull();
    expect(projectGrowth([project(-1)], now)).toBeNull();
  });

  it('compares current active project count with the count seven days ago', () => {
    expect(projectGrowth([project(8), project(7), project(1)], now)).toBe(50);
    expect(projectGrowth([project(8)], now)).toBe(0);
  });

  const deployment = (seconds: number, status = 'deployed') => ({
    status, createdAt: '2026-11-01T00:00:00Z',
    deployedAt: new Date(Date.parse('2026-11-01T00:00:00Z') + seconds * 1000).toISOString(),
  });

  it('averages real completion durations including historic successful deployments', () => {
    expect(averageDeployTime([deployment(60), deployment(120), deployment(180, 'terminated')])).toBe('2m 0s');
    expect(averageDeployTime([deployment(15), deployment(30)])).toBe('23s');
    expect(averageDeployTime([deployment(0)])).toBe('0s');
  });

  it('ignores incomplete, failed and invalid samples and handles an empty install', () => {
    expect(averageDeployTime([])).toBe('—');
    expect(averageDeployTime([
      deployment(100, 'failed'), deployment(100, 'building'), deployment(-1),
      { status: 'deployed', createdAt: 'invalid', deployedAt: 'invalid' },
      { status: 'deployed', createdAt: '2026-11-01', deployedAt: null },
    ])).toBe('—');
    expect(averageDeployTime([deployment(30), deployment(-1), deployment(100, 'pending')])).toBe('30s');
  });
});
