import { withTimeout } from '../../../src/lib/with-timeout';

describe('bootstrap status probes', () => {
  it('returns the fallback when a probe hangs instead of blocking the request', async () => {
    const hanging = new Promise<string>(() => { /* never settles, like an unreachable Mongo */ });
    const started = Date.now();
    await expect(withTimeout(hanging, 50, 'offline')).resolves.toBe('offline');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('returns the probe result when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve('running'), 1000, 'offline')).resolves.toBe('running');
  });

  it('treats a failing probe as the fallback', async () => {
    await expect(withTimeout(Promise.reject(new Error('ECONNREFUSED')), 1000, 'offline')).resolves.toBe('offline');
  });
});
