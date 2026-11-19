import { projectIdMongoFilter, resolveProjectRef } from '../../../src/lib/project-resolve';

const OLD = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'shop', deletedAt: new Date('2026-01-01') };
const NEW = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'shop', deletedAt: null };
const SOLO = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'blog', deletedAt: null };

/** Minimal TypeORM-ish repository over rows: understands id, name, IsNull() and Not(). */
function dsOver(rows: any[]) {
  const match = (row: any, where: any) => Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && v._type === 'isNull') return row[k] === null;
    if (v && typeof v === 'object' && v._type === 'not') return row[k] !== v._value;
    return row[k] === v;
  });
  return { getRepository: () => ({ findOne: async ({ where }: any) => rows.find((r) => match(r, where)) || null }) } as any;
}

it('resolves a reused name to the project that is not deleted', async () => {
  const ds = dsOver([OLD, NEW]);
  expect(await resolveProjectRef(ds, 'shop')).toEqual({ id: NEW.id, name: 'shop' });
  expect(await resolveProjectRef(ds, OLD.id)).toEqual({ id: OLD.id, name: 'shop' });
});

it('matches legacy name-keyed data only while the name was never reused', async () => {
  expect(await projectIdMongoFilter(dsOver([SOLO]), SOLO.id)).toEqual({ projectId: { $in: [SOLO.id, 'blog'] } });
  // After a delete and a new project with the same name, neither sees the other's name-keyed data.
  expect(await projectIdMongoFilter(dsOver([OLD, NEW]), NEW.id)).toEqual({ projectId: NEW.id });
  expect(await projectIdMongoFilter(dsOver([OLD, NEW]), 'shop')).toEqual({ projectId: NEW.id });
});
