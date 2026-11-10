import { DEFAULT_CONFIGS, draftToBody, timelineBars, SyntheticResultView } from './synthetics.component';

describe('synthetics editor helpers', () => {
  const base = {
    id: null, name: ' Home ', type: 'http' as const, enabled: true, intervalSeconds: 300, timeoutMs: 10000,
    configText: JSON.stringify(DEFAULT_CONFIGS.http), alertEnabled: true, failureThreshold: 2, severity: 'critical' as const,
    secretNames: ['OLD'], newSecrets: [{ name: 'TOKEN', value: 'abc' }, { name: '', value: 'ignored' }], removedSecrets: ['OLD'],
  };

  it('builds the API body with secret changes only', () => {
    const body = draftToBody(base);
    expect(body['name']).toBe('Home');
    expect(body['config'].url).toBe('https://example.com/');
    expect(body['alertPolicy']).toEqual({ enabled: true, failureThreshold: 2, severity: 'critical' });
    expect(body['secrets']).toEqual({ TOKEN: 'abc', OLD: null });
  });

  it('omits secrets when unchanged and rejects invalid JSON', () => {
    expect(draftToBody({ ...base, newSecrets: [], removedSecrets: [] })['secrets']).toBeUndefined();
    expect(() => draftToBody({ ...base, configText: '{nope' })).toThrowError(/not valid JSON/);
  });

  it('timeline: oldest first, height relative to the slowest run', () => {
    const r = (id: string, latencyMs: number | null, status: 'pass' | 'fail'): SyntheticResultView => ({
      id, status, latencyMs, statusCode: null, error: null, assertions: null, steps: null, sslExpiresAt: null, hasScreenshot: false, startedAt: '2026-11-10T10:00:00Z',
    });
    const bars = timelineBars([r('new', 50, 'pass'), r('mid', null, 'fail'), r('old', 100, 'pass')]);
    expect(bars.map((b) => b.id)).toEqual(['old', 'mid', 'new']);
    expect(bars.map((b) => b.height)).toEqual([100, 100, 50]);
  });
});
