/**
 * TypeormOperationStore against a minimal fake DataSource: row mapping, encrypted sensitive
 * state (wiped when terminal), fenced writes, outbox insert in the same transaction.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'operation-store-test-secret';

import { TypeormOperationStore, FencedError, OperationRecord } from '../../../src/lib/operation-store';

type Row = Record<string, any>;

function fakeDs() {
  const tables: Record<string, Row[]> = { Operation: [], OperationStep: [], OutboxMessage: [] };
  const match = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && (v as any)._type === 'in') return (v as any)._value.includes(row[k]);
    return row[k] === v;
  });
  const repo = (name: string) => ({
    insert: async (rows: Row | Row[]) => {
      for (const r of Array.isArray(rows) ? rows : [rows]) tables[name].push({ id: r.id || `${name}-${tables[name].length + 1}`, createdAt: new Date(), updatedAt: new Date(), ...r });
    },
    findOne: async ({ where }: any) => tables[name].find((r) => match(r, where)) || null,
    find: async ({ where }: any) => tables[name].filter((r) => match(r, where)),
    update: async (where: Row, patch: Row) => {
      for (const r of tables[name].filter((x) => match(x, where))) Object.assign(r, patch);
    },
  });
  const ds: any = {
    tables,
    getRepository: (e: any) => repo(e.name),
    transaction: async (fn: any) => fn(ds),
    createQueryBuilder: () => {
      const q: any = {};
      q.update = (e: any) => { q.entity = e.name; return q; };
      q.set = (s: Row) => { q.patch = s; return q; };
      q.where = (sql: string, params: Row) => { q.sql = sql; q.params = params; return q; };
      q.execute = async () => {
        const rows = tables[q.entity].filter((r) => r.id === q.params.id && (!q.sql.includes('lock_fence') || r.lockFence === q.params.fence));
        for (const r of rows) {
          for (const [k, v] of Object.entries(q.patch)) r[k] = typeof v === 'function' ? r[k] + 1 : v;
          r.updatedAt = new Date();
        }
        return { affected: rows.length };
      };
      return q;
    },
  };
  return ds;
}

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const now = new Date();
  return {
    id: 'op-1', type: 't', projectId: null, lockKey: 'lock:x', lockFence: null, status: 'pending', currentStep: 0,
    inputHash: 'h', input: { a: 1 }, state: { password: 'hunter2' }, sensitive: true, result: null, error: null,
    attempts: 0, createdById: null, createdAt: now, updatedAt: now, finishedAt: null,
    steps: [{ index: 0, name: 's', status: 'pending', attempts: 0, output: null, error: null, startedAt: null, finishedAt: null }],
    ...overrides,
  };
}

it('encrypts sensitive state at rest and decrypts it on read', async () => {
  const ds = fakeDs();
  const store = new TypeormOperationStore(async () => ds);
  await store.create(record());
  const row = ds.tables.Operation[0];
  expect(row.state).toBeNull();
  expect(row.stateEncrypted).toBeTruthy();
  expect(row.stateEncrypted).not.toContain('hunter2');
  const back = await store.get('op-1');
  expect(back!.state).toEqual({ password: 'hunter2' });
  expect(back!.sensitive).toBe(true);
  expect(back!.steps).toHaveLength(1);
});

it('claims with a fence, rejects writes from a stale fence, and wipes secrets when terminal', async () => {
  const ds = fakeDs();
  const store = new TypeormOperationStore(async () => ds);
  await store.create(record());
  const claimed = await store.claim('op-1', 'r:1');
  expect(claimed!.attempts).toBe(1);
  expect(claimed!.lockFence).toBe('r:1');
  await store.claim('op-1', 'r:2');

  const stale = record({ status: 'failed' });
  await expect(store.save(stale, 'r:1')).rejects.toBeInstanceOf(FencedError);
  expect(ds.tables.Operation[0].status).toBe('pending');

  const done = record({ status: 'succeeded', steps: [{ index: 0, name: 's', status: 'succeeded', attempts: 1, output: { ok: true }, error: null, startedAt: new Date(), finishedAt: new Date() }] });
  await store.save(done, 'r:2', [{ kind: 'notify.roles', payload: { title: 'x' } }]);
  const row = ds.tables.Operation[0];
  expect(row.status).toBe('succeeded');
  expect(row.stateEncrypted).toBeNull();
  expect(row.state).toBeNull();
  expect(ds.tables.OperationStep[0]).toMatchObject({ status: 'succeeded', output: { ok: true } });
  expect(ds.tables.OutboxMessage).toEqual([expect.objectContaining({ operationId: 'op-1', kind: 'notify.roles' })]);
});

it('stores non-sensitive state as plain jsonb', async () => {
  const ds = fakeDs();
  const store = new TypeormOperationStore(async () => ds);
  await store.create(record({ id: 'op-2', sensitive: false, state: { deploymentId: 'd1' } }));
  expect(ds.tables.Operation[0]).toMatchObject({ state: { deploymentId: 'd1' }, stateEncrypted: null });
  expect((await store.get('op-2'))!.sensitive).toBe(false);
});
