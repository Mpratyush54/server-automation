/**
 * Issue #18 acceptance guard: no `new Map` holding auth/session/rate-limit state in src.
 * Every remaining Map must be listed here with the reason it is not shared state.
 */
import fs from 'fs';
import path from 'path';

const ALLOWED: Record<string, string> = {
  // In-memory OneTimeCodeStore: test double / PLATFORM_STATE_STORE=memory only.
  'lib/oidc-codes.ts': 'test double',
  // Short-TTL local permission cache; invalidated cluster-wide over Redis pub/sub.
  'middleware/auth.ts': 'local cache with pub/sub invalidation',
  // Request-scoped lookup table (users by id) inside one handler.
  'routes/projects.ts': 'request-scoped',
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

it('only allow-listed files construct Maps', () => {
  const src = path.join(__dirname, '..', '..', 'src');
  const offenders = walk(src)
    .filter((f) => /new Map\s*[<(]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(src, f).split(path.sep).join('/'))
    .filter((rel) => !(rel in ALLOWED));
  expect(offenders).toEqual([]);
});
