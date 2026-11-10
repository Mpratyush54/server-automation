import { replayObjectPrefix, submitLokiDeletes } from '../../../src/lib/gdpr-delete';

describe('replayObjectPrefix', () => {
  it('builds the #40 object-key contract', () => {
    expect(replayObjectPrefix('p1', { userId: 'u1' })).toBe('replays/p1/user/u1/');
    expect(replayObjectPrefix('p1', { sessionId: 's1' })).toBe('replays/p1/session/s1/');
  });
});

describe('submitLokiDeletes', () => {
  const original = process.env.LOKI_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.LOKI_URL;
    else process.env.LOKI_URL = original;
    jest.restoreAllMocks();
  });

  it('posts a delete request per identifier', async () => {
    process.env.LOKI_URL = 'http://loki.test:3100';
    const axios = require('axios');
    const spy = jest.spyOn(axios, 'post').mockResolvedValue({ status: 204 });
    const r = await submitLokiDeletes('proj-1', 'user-42', 'sess-9');
    expect(r.requests).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toContain('/loki/api/v1/delete');
    expect((spy.mock.calls[0][2] as any).params.query).toContain('proj-1');
    expect((spy.mock.calls[0][2] as any).params.query).toContain('user-42');
  });

  it('returns a warning when Loki is unreachable', async () => {
    process.env.LOKI_URL = 'http://loki.test:3100';
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await submitLokiDeletes('proj-1', 'user-42', null);
    expect(r.requests).toBe(0);
    expect(r.warning).toMatch(/loki delete failed/);
  });
});
