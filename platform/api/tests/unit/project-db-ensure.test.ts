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

const mockMongoCommand = jest.fn(async (cmd: any) => (cmd.usersInfo ? { users: [] } : { ok: 1 }));
const mockMongoDb = jest.fn((_name: string) => ({ command: mockMongoCommand }));
const mockCreateConnection = jest.fn((_uri: string, _opts?: any) => {
  const conn: any = {
    on: jest.fn(),
    asPromise: jest.fn(async () => conn),
    getClient: () => ({ db: mockMongoDb }),
    close: jest.fn(async () => undefined),
  };
  return conn;
});
jest.mock('mongoose', () => ({ __esModule: true, default: { createConnection: mockCreateConnection }, createConnection: mockCreateConnection }));

const mockRedisCall = jest.fn(async (..._args: any[]) => 'OK');
const mockRedisInstances: any[] = [];
jest.mock('ioredis', () => {
  const Redis = jest.fn().mockImplementation((opts: any) => {
    const client = { opts, on: jest.fn(), connect: jest.fn(async () => undefined), call: mockRedisCall, disconnect: jest.fn() };
    mockRedisInstances.push(client);
    return client;
  });
  return { __esModule: true, default: Redis };
});

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

  it('creates a per-project MongoDB user with readWrite on only its own database', async () => {
    process.env.MONGODB_URI = 'mongodb://root:platform-password@mongo-0:27017,mongo-1:27017/plat_platform?replicaSet=rs0&authSource=admin';
    mockMongoCommand.mockClear(); mockMongoDb.mockClear();
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['mongo']);
    const dbName = mockMongoDb.mock.calls[0][0];
    expect(dbName).toMatch(/^plat_[a-f0-9]{20}_[a-f0-9]{12}$/);
    const create: any = mockMongoCommand.mock.calls.map((c: any[]) => c[0]).find((c: any) => c.createUser);
    expect(create).toEqual({ createUser: `${dbName}_user`, pwd: expect.any(String), roles: [{ role: 'readWrite', db: dbName }] });
    expect(creds.mongo.uri).toBe(`mongodb://${dbName}_user:${encodeURIComponent(create.pwd)}@mongo-0:27017,mongo-1:27017/${dbName}?replicaSet=rs0&authSource=${dbName}`);
    expect(JSON.stringify(creds)).not.toContain('platform-password');
    expect(JSON.stringify(creds)).not.toContain('root');
    expect(store.find((s) => s.key === 'MONGO_PASSWORD').encryptedValue).toBe(`enc:${create.pwd}`);
  });

  it('buildProjectMongoUri keeps multi-host replicaSet seeds and never carries the root user', () => {
    const { buildProjectMongoUri } = require('../../src/lib/project-db-ensure');
    const platform = 'mongodb://root:platform-password@mongo-0:27017,mongo-1:27017,mongo-2:27017/plat_platform?replicaSet=rs0&authSource=admin';
    const uri = buildProjectMongoUri(platform, 'plat_proj_dev', 'plat_proj_dev_user', 'proj-secret');
    expect(uri).toBe('mongodb://plat_proj_dev_user:proj-secret@mongo-0:27017,mongo-1:27017,mongo-2:27017/plat_proj_dev?replicaSet=rs0&authSource=plat_proj_dev');
    expect(uri).not.toContain('root');
    expect(uri).not.toContain('platform-password');
  });

  it('updates the existing MongoDB user and reuses its stored password', async () => {
    process.env.MONGODB_URI = 'mongodb://root:platform-password@mongo:27017/plat_platform';
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const first = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['mongo']);
    mockMongoCommand.mockClear();
    mockMongoCommand.mockImplementation(async (cmd: any) => (cmd.usersInfo ? { users: [{ user: 'x' }] } : { ok: 1 }));
    const second = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['mongo']);
    mockMongoCommand.mockImplementation(async (cmd: any) => (cmd.usersInfo ? { users: [] } : { ok: 1 }));
    expect(second.mongo.uri).toBe(first.mongo.uri);
    expect(mockMongoCommand.mock.calls.map((c: any[]) => c[0]).some((c: any) => c.updateUser)).toBe(true);
  });

  it('never reuses a legacy MONGO_URI that carries platform credentials', async () => {
    process.env.MONGODB_URI = 'mongodb://root:platform-password@mongo:27017/plat_platform';
    store.push({ projectId: 'proj-1', environmentId: 'development', key: 'MONGO_URI', encryptedValue: 'enc:mongodb://root:platform-password@mongo:27017/plat_demo', isActive: true });
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['mongo']);
    expect(creds.mongo.uri).not.toContain('platform-password');
    expect(store.find((s) => s.key === 'MONGO_URI').encryptedValue).not.toContain('platform-password');
  });

  it('creates a Redis ACL user confined to the project key prefix', async () => {
    process.env.REDIS_HOST = 'redis-master';
    process.env.REDIS_PASSWORD = 'platform-password';
    mockRedisCall.mockClear(); mockRedisInstances.length = 0;
    // Legacy installs copied the platform password into project secrets.
    store.push({ projectId: 'proj-1', environmentId: 'development', key: 'REDIS_PASSWORD', encryptedValue: 'enc:platform-password', isActive: true });
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const creds = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['redis']);
    expect(mockRedisInstances[0].opts.password).toBe('platform-password'); // admin connection only
    const acl = mockRedisCall.mock.calls.find((c: any[]) => c[1] === 'SETUSER')!;
    const { username, password, keyPrefix } = creds.redis;
    expect(username).toMatch(/^plat_[a-f0-9]{20}_[a-f0-9]{12}$/);
    expect(keyPrefix).toMatch(/^plat:[a-f0-9]{20}:[a-f0-9]{12}:$/);
    expect(acl).toEqual(['ACL', 'SETUSER', username, 'reset', 'on', `>${password}`, `~${keyPrefix}*`, `&${keyPrefix}*`, '+@all', '-@admin', '-@dangerous']);
    expect(password).not.toBe('platform-password');
    expect(JSON.stringify(creds)).not.toContain('platform-password');
    expect(creds.redis.host).toBe('redis-master');
  });

  it('reports a failed type as an error and throws only when every type failed', async () => {
    process.env.REDIS_PASSWORD = 'platform-password';
    mockRedisCall.mockRejectedValueOnce(new Error('NOPERM'));
    const { resolveProjectDbCredentials } = require('../../src/lib/project-db-ensure');
    const mixed = await resolveProjectDbCredentials('proj-1', 'demo', 'development', ['postgres', 'redis']);
    expect(mixed.postgres.user).toMatch(/^plat_/);
    expect(mixed.redis).toEqual({ status: 'error', error: 'NOPERM' });
    mockRedisCall.mockRejectedValueOnce(new Error('NOPERM'));
    await expect(resolveProjectDbCredentials('proj-1', 'demo', 'development', ['redis'])).rejects.toThrow('NOPERM');
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
