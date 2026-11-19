import { getMetadataArgsStorage } from 'typeorm';
import { ProjectNameReuse1799000000610 } from '../../../src/migrations/1799000000610-ProjectNameReuse';
import { Project } from '../../../src/entities/Project';

const runner = () => {
  const queries: string[] = [];
  return { queries, q: { query: jest.fn(async (sql: string) => { queries.push(sql); return []; }) } as any };
};

it('replaces the table-wide unique name with a unique index over projects that are not deleted', async () => {
  const { q, queries } = runner();
  await new ProjectNameReuse1799000000610().up(q);
  expect(queries[0]).toContain('DROP CONSTRAINT IF EXISTS "UQ_2187088ab5ef2a918473cb99007"');
  expect(queries[1]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "projects_name_active"');
  expect(queries[1]).toContain('WHERE deleted_at IS NULL');
});

it('renames reused names of deleted projects before restoring the table-wide constraint', async () => {
  const { q, queries } = runner();
  await new ProjectNameReuse1799000000610().down(q);
  expect(queries[0]).toContain('DROP INDEX IF EXISTS "projects_name_active"');
  expect(queries[1]).toMatch(/UPDATE "projects" p SET "name"[\s\S]*deleted_at" IS NOT NULL/);
  expect(queries[2]).toContain('ADD CONSTRAINT "UQ_2187088ab5ef2a918473cb99007" UNIQUE ("name")');
});

it('declares the same partial index on the entity, and no table-wide unique name', () => {
  const storage = getMetadataArgsStorage();
  const idx = storage.indices.find((i) => i.target === Project && i.name === 'projects_name_active');
  expect(idx).toBeDefined();
  expect(idx!.unique).toBe(true);
  expect(idx!.where).toBe('deleted_at IS NULL');
  const nameCol = storage.columns.find((c) => c.target === Project && c.propertyName === 'name');
  expect(nameCol!.options.unique).toBeFalsy();
});
