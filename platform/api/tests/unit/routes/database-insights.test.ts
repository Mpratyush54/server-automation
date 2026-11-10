import express from 'express';
import request from 'supertest';

const mockRead = jest.fn(async () => ({ enabled: true, postgres: { topQueries: [] } }));
const mockFind = jest.fn(async () => ({ id: 'a', environments: [{ name: 'production' }], databaseResources: { production: { dbName: 'a_db', username: 'a_user' } } }));
jest.mock('../../../src/config/database', () => ({ getDb: async () => ({ getRepository: () => ({ findOne: mockFind }) }) }));
jest.mock('../../../src/lib/database-insights', () => ({ monitoringEnabled: () => true, databaseInsights: (...args: any[]) => (mockRead as any)(...args) }));
jest.mock('../../../src/lib/project-access', () => ({ requireProjectAccess: async (_req: any, id: string) => id === 'a' ? { ok: true } : { ok: false, status: 403, error: 'Forbidden' } }));
jest.mock('../../../src/middleware/auth', () => ({ expressAuthenticate: (req: any, res: any, next: any) => req.headers.authorization ? next() : res.sendStatus(401) }));
import routes from '../../../src/routes/database-insights';
const app = express(); app.use(routes);

describe('database insights access boundary', () => {
  beforeEach(() => { mockRead.mockClear(); mockFind.mockClear(); });
  it('requires authentication', async () => {
    expect((await request(app).get('/projects/a/databases/insights')).status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });
  it('denies other projects before looking up databases', async () => {
    expect((await request(app).get('/projects/b/databases/insights').set('Authorization', 'test')).status).toBe(403);
    expect(mockFind).not.toHaveBeenCalled(); expect(mockRead).not.toHaveBeenCalled();
  });
  it('rejects an unknown environment', async () => {
    expect((await request(app).get('/projects/a/databases/insights?environment=other').set('Authorization', 'test')).status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
  });
  it('ignores client database names and passes the stored project identity', async () => {
    const res = await request(app).get('/projects/a/databases/insights?database=b_db').set('Authorization', 'test');
    expect(res.status).toBe(200);
    expect(mockRead.mock.calls[0]).toEqual([expect.objectContaining({ databaseResources: { production: { dbName: 'a_db', username: 'a_user' } } }), 'production']);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
