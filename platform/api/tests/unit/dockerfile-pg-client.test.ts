import * as fs from 'fs';
import * as path from 'path';

// lib/database-service.ts spawns pg_dump / pg_restore for database backups,
// restores and the backups taken before a project is deleted. Without the
// client in the runtime image every one of them failed with
// "spawn pg_dump ENOENT" (seen on a real cluster: project deletion stopped at
// back-up-databases). pg_dump refuses servers newer than itself, so its major
// must be at least the CloudNativePG server image's.
describe('API runtime image: PostgreSQL client', () => {
  const root = path.resolve(__dirname, '../../../..');
  const dockerfile = fs.readFileSync(path.join(root, 'platform/api/Dockerfile'), 'utf8');
  const versions = fs.readFileSync(path.join(root, 'platformctl/internal/versions/versions.go'), 'utf8');

  it('installs a pg_dump at least as new as the PostgreSQL server', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime.length).toBeGreaterThan(0);
    const client = /apk add[^\n]*postgresql(\d+)-client/.exec(runtime);
    expect(client).not.toBeNull();
    const server = /CNPGPostgresImage\s*=\s*"[^"]*:(\d+)\./.exec(versions);
    expect(server).not.toBeNull();
    expect(Number(client![1])).toBeGreaterThanOrEqual(Number(server![1]));
  });
});
