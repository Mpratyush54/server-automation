import { SourceBuilds1799000000550 } from '../../../src/migrations/1799000000550-SourceBuilds';
import { RepositoryBinding1799000000560 } from '../../../src/migrations/1799000000560-RepositoryBinding';

const runner = (rows: any[] = []) => {
  const queries: string[] = []; const params: any[][] = [];
  return { queries, params, q: { query: jest.fn(async (sql: string, p?: any[]) => { queries.push(sql); params.push(p || []); return sql.startsWith('SELECT') ? rows : []; }) } as any };
};

it('restores the previous deployments.image_tag width when source builds are rolled back', async () => {
  const { q, queries } = runner();
  await new SourceBuilds1799000000550().down(q);
  expect(queries).toContain('ALTER TABLE deployments ALTER COLUMN image_tag TYPE varchar(200) USING left(image_tag, 200)');
});

it('keys repositories so only the oldest active project keeps a shared repository', async () => {
  const { q, params, queries } = runner([
    { id: 'old', repository_url: 'https://github.com/Acme/App.git', is_active: true },
    { id: 'gone', repository_url: 'https://github.com/acme/app', is_active: false },
    { id: 'dup', repository_url: 'git@github.com:acme/app.git', is_active: true },
    { id: 'none', repository_url: null, is_active: true },
  ]);
  await new RepositoryBinding1799000000560().up(q);
  const updates = Object.fromEntries(params.filter(p => p.length === 2).map(([key, id]) => [id, key]));
  expect(updates).toEqual({ old: 'github.com/acme/app', gone: 'github.com/acme/app', dup: null, none: null });
  expect(queries[queries.length - 1]).toContain('CREATE UNIQUE INDEX IF NOT EXISTS projects_repository_key_active');
});
