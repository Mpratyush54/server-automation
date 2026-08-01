/**
 * Tests for project DB ensure helpers.
 */
const store: any[] = [];

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: () => ({
      find: jest.fn(async ({ where }: any) =>
        store.filter(
          (s) =>
            s.projectId === where.projectId &&
            s.environmentId === where.environmentId &&
            s.isActive === true,
        ),
      ),
      findOne: jest.fn(async ({ where }: any) =>
        store.find(
          (s) =>
            s.projectId === where.projectId &&
            s.environmentId === where.environmentId &&
            s.key === where.key &&
            s.isActive === true,
        ) || null,
      ),
      create: (x: any) => x,
      save: jest.fn(async (x: any) => {
        const idx = store.findIndex(
          (s) =>
            s.projectId === x.projectId &&
            s.environmentId === x.environmentId &&
            s.key === x.key,
        );
        if (idx >= 0) store[idx] = { ...x, isActive: true };
        else store.push({ ...x, isActive: true });
        return x;
      }),
    }),
  })),
}));

jest.mock('../../src/lib/secrets-encryption', () => ({
  encryptValue: (v: string) => `enc:${v}`,
  decryptValue: (v: string) => String(v).replace(/^enc:/, ''),
}));

const query = jest.fn(async (sql: string) => {
  if (String(sql).includes('pg_database')) return { rows: [] };
  return { rows: [] };
});
const release = jest.fn();
const connect = jest.fn(async () => ({ query, release }));
const end = jest.fn(async () => undefined);

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect, end, query })),
}));

describe('project-db-ensure', () => {
  beforeEach(() => {
    store.length = 0;
    process.env.POSTGRES_HOST = 'postgres.databases.svc';
    process.env.POSTGRES_PORT = '5432';
    process.env.POSTGRES_USER = 'postgres';
    process.env.POSTGRES_PASSWORD = 'postgres';
    process.env.JWT_SECRET = 'test-secret-key';
    delete process.env.SECRETS_ENCRYPTION_KEY;
    query.mockClear();
    connect.mockClear();
  });

  it('ensurePostgresForProject returns ready with cluster host', async () => {
    const { ensurePostgresForProject } = require('../../src/lib/project-db-ensure');
    const r = await ensurePostgresForProject('proj-1', 'demo', 'development');
    expect(r.status).toBe('ready');
    expect(r.creds?.host).toBe('postgres.databases.svc');
    expect(r.creds?.dbName).toMatch(/plat_demo/);
    expect(r.creds?.password).toBeTruthy();
  });

  it('resolveProjectDbCredentials returns postgres shape after ensure', async () => {
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['postgres']);
    expect(creds.postgres).toBeDefined();
    expect(creds.postgres.host).toBe('postgres.databases.svc');
    expect(creds.postgres.database).toMatch(/plat_demo/);
    expect(creds.postgres.user).toMatch(/plat_demo/);
    expect(creds.postgres.password).toBeTruthy();
  });

  it('second ensure reuses stored password', async () => {
    const { ensurePostgresForProject } = require('../../src/lib/project-db-ensure');
    const first = await ensurePostgresForProject('proj-1', 'demo', 'development');
    const second = await ensurePostgresForProject('proj-1', 'demo', 'development');
    expect(second.status).toBe('ready');
    expect(second.creds?.password).toBe(first.creds?.password);
    expect(second.creds?.dbName).toBe(first.creds?.dbName);
  });

  it('ensureRedisForProject stores key prefix', async () => {
    process.env.REDIS_HOST = 'redis.databases.svc';
    process.env.REDIS_PORT = '6379';
    const { ensureRedisForProject, resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const r = await ensureRedisForProject('proj-1', 'demo', 'development');
    expect(r.status).toBe('ready');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['redis']);
    expect(creds.redis.host).toBe('redis.databases.svc');
    expect(creds.redis.keyPrefix).toMatch(/plat:demo:development/);
  });
});
