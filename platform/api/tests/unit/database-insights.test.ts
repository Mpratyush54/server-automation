const query = jest.fn();
const end = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query, end })) }));
import { mongoOperation, safeSql, postgresInsights, monitoringEnabled } from '../../src/lib/database-insights';

describe('project database insights', () => {
  beforeEach(() => { query.mockReset(); end.mockReset(); });
  it('binds both database and owner before returning top queries', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ sizeBytes: 10, connections: 1 }] })
      .mockResolvedValueOnce({ rows: [{ query: "SELECT * FROM users WHERE email = 'private@example.test'", calls: 2 }] });
    const result = await postgresInsights('project_a', 'owner_a');
    const [sql, args] = query.mock.calls[2];
    expect(sql).toContain('WHERE dbid=(SELECT oid FROM pg_database WHERE datname=$1)');
    expect(sql).toContain('AND userid=(SELECT oid FROM pg_roles WHERE rolname=$2)');
    expect(args).toEqual(['project_a', 'owner_a']);
    expect(JSON.stringify(result)).not.toContain('private@example.test');
    expect(end).toHaveBeenCalled();
  });
  it('closes a pool when the extension is unavailable', async () => {
    query.mockRejectedValueOnce(new Error('disabled'));
    await expect(postgresInsights('project_a', 'owner_a')).rejects.toThrow('disabled');
    expect(end).toHaveBeenCalled();
  });
  it('rejects another database including prefix collisions', () => {
    expect(mongoOperation({ ns: 'project_b.users', command: { password: 'secret' } }, 'project_a')).toBeNull();
    expect(mongoOperation({ ns: 'project_ab.users' }, 'project_a')).toBeNull();
    expect(mongoOperation({ ns: 'project_a.users', op: 'query', millis: 500, command: { filter: { email: 'secret' } } }, 'project_a'))
      .toEqual({ query: 'query { … }', latencyMs: 500, rows: 0, at: undefined });
  });
  it.each([
    "SELECT * FROM users WHERE email='secret' AND id=123",
    'SELECT $$secret$$, $tag$hidden$tag$, "private_identifier" FROM users',
    "SELECT * FROM users -- secret\n WHERE id=$1 /* hidden */",
    "CREATE USER secret PASSWORD 'hidden'",
  ])('does not disclose literals or identifiers: %s', sql => {
    expect(safeSql(sql)).not.toMatch(/secret|hidden|private_identifier|123|users/i);
  });
  it('requires the installed full observability backend', () => {
    const previous = process.env.PLATFORM_OBSERVABILITY;
    process.env.PLATFORM_OBSERVABILITY = ''; expect(monitoringEnabled()).toBe(false);
    process.env.PLATFORM_OBSERVABILITY = 'enabled'; expect(monitoringEnabled()).toBe(true);
    if (previous === undefined) delete process.env.PLATFORM_OBSERVABILITY; else process.env.PLATFORM_OBSERVABILITY = previous;
  });
});
