/**
 * Tests for project DB ensure helpers.
 */
const store: any[] = [];
const project: any = { id: 'proj-1', name: 'demo', databaseResources: null };

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: (entity: any) => entity.name === 'Project' ? { findOne: jest.fn(async () => project), save: jest.fn(async (x: any) => x) } : ({
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
const escapeIdentifier = jest.fn((value: string) => '"' + value.replace(/"/g, '""') + '"');
const escapeLiteral = jest.fn((value: string) => "'" + value.replace(/'/g, "''") + "'");
const connect = jest.fn(async () => ({ query, release, escapeIdentifier, escapeLiteral }));
const end = jest.fn(async () => undefined);

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({ connect, end, query })),
}));

describe('project-db-ensure', () => {
  beforeEach(() => {
    store.length = 0;
    project.databaseResources = null;
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
    expect(r.creds?.dbName).toMatch(/^plat_[a-f0-9]{20}_[a-f0-9]{12}/);
    expect(r.creds?.password).toBeTruthy();
  });

  it('resolveProjectDbCredentials returns postgres shape after ensure', async () => {
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['postgres']);
    expect(creds.postgres).toBeDefined();
    expect(creds.postgres.host).toBe('postgres.databases.svc');
    expect(creds.postgres.database).toMatch(/^plat_[a-f0-9]{20}_[a-f0-9]{12}/);
    expect(creds.postgres.user).toMatch(/^plat_[a-f0-9]{20}_[a-f0-9]{12}/);
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

  it.each(['mongo', 'redis'])('fails closed for shared %s credentials', async (type) => {
    process.env.MONGODB_URI = 'mongodb://root:platform-password@localhost/admin';
    process.env.REDIS_PASSWORD = 'platform-password';
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    await expect(resolveProjectDbCredentials('proj-1', 'demo', 'development', [type])).rejects.toThrow(/Isolated/);
    expect(store).toHaveLength(0);
  });

  it('does not return platform Postgres credentials on provisioning failure', async () => {
    connect.mockRejectedValueOnce(new Error('offline'));
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    await expect(resolveProjectDbCredentials('proj-1', 'demo', 'development', ['postgres'])).rejects.toThrow('offline');
  });

  it('never uses editable secret identities for privileged SQL', async () => {
    store.push(...['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD'].map(key => ({
      projectId: 'proj-1', environmentId: 'development', key, encryptedValue: 'enc:postgres', isActive: true,
    })));
    const { ensurePostgresForProject } = require('../../src/lib/project-db-ensure');
    expect((await ensurePostgresForProject('proj-1', 'demo', 'development')).status).toBe('error');
    expect(query).not.toHaveBeenCalled();
  });

  it('quotes an injected password as a literal using the pg client', async () => {
    project.databaseResources = { development: { dbName: 'plat_existing', username: 'plat_existing_user' } };
    const password = `x'; ALTER ROLE postgres SUPERUSER; --`;
    store.push({ projectId: 'proj-1', environmentId: 'development', key: 'POSTGRES_PASSWORD', encryptedValue: `enc:${password}`, isActive: true });
    const { ensurePostgresForProject } = require('../../src/lib/project-db-ensure');
    expect((await ensurePostgresForProject('proj-1', 'renamed', 'development')).status).toBe('ready');
    expect(escapeLiteral).toHaveBeenCalledWith(password);
    expect(escapeIdentifier).toHaveBeenCalledWith('plat_existing_user');
    expect(query.mock.calls.map(call => call[0]).join(' ')).toContain(`PASSWORD 'x''; ALTER ROLE postgres SUPERUSER; --'`);
  });
});
