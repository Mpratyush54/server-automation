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
    // Regression (VM): streams are labelled platform_project_id, and Loki rejects start=0.
    expect((spy.mock.calls[0][2] as any).params.query).toMatch(/^\{platform_project_id="proj-1"\}/);
    expect((spy.mock.calls[0][2] as any).params.start).not.toBe('0');
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

describe('deletePostgresErrorEvents (#41 error events)', () => {
  it('deletes events whose payload names the user or session and counts them', async () => {
    const { deletePostgresErrorEvents } = require('../../../src/lib/gdpr-delete');
    const calls: any[] = [];
    const ds = { query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return [[{ id: 'a' }, { id: 'b' }], 2]; } };
    expect(await deletePostgresErrorEvents(ds, 'proj-1', 'user-42', null)).toBe(2);
    expect(calls[0].sql).toMatch(/DELETE FROM error_events WHERE project_id = \$1/);
    expect(calls[0].params).toEqual(['proj-1', 'user-42', null]);
  });
  it('is a no-op without a subject and tolerates a missing table', async () => {
    const { deletePostgresErrorEvents } = require('../../../src/lib/gdpr-delete');
    expect(await deletePostgresErrorEvents({ query: async () => { throw new Error('x'); } }, 'p', null, null)).toBe(0);
    expect(await deletePostgresErrorEvents({ query: async () => { throw new Error('relation missing'); } }, 'p', 'u', null)).toBe(0);
  });
});
