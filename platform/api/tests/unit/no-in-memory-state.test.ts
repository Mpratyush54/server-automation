/**
 * Issue #18 acceptance guard: no `new Map` holding auth/session/rate-limit state in src.
 * Every remaining Map must be listed here with the reason it is not shared state.
 */
import fs from 'fs';
import path from 'path';

const ALLOWED: Record<string, string> = {
  // Bounded immutable source-map cache; Postgres/MinIO remain authoritative (#41).
  'lib/error-sourcemaps.ts': '16-entry content-addressed performance cache',
  // In-memory OneTimeCodeStore: test double / PLATFORM_STATE_STORE=memory only.
  'lib/oidc-codes.ts': 'test double',
  // Short-TTL local permission cache; invalidated cluster-wide over Redis pub/sub.
  'middleware/auth.ts': 'local cache with pub/sub invalidation',
  // Request-scoped lookup table (users by id) inside one handler.
  'routes/projects.ts': 'request-scoped',
  // Per-process Prometheus counters (#19); scraped from every pod and summed.
  'lib/job-metrics.ts': 'per-process metrics',
  // Leader-job timers of this process (#19).
  'lib/scheduler.ts': 'process-local timers',
  // Locks this process holds + the memory backend used only when Redis and Postgres are both unusable (#23).
  'lib/locks.ts': 'process-local holder index / last-resort fallback',
  // MemoryOperationStore: tests, or when Postgres is unusable (#23).
  'lib/operation-store.ts': 'test double / fallback',
  // Operation definition registry + this process's in-flight runs (#23).
  'lib/operations.ts': 'code registry / process-local runs',
  // Outbox handler registry (code, not state) (#23).
  'lib/outbox.ts': 'code registry',
  // Fallback de-dupe only when the webhook_deliveries table is unusable (#23).
  'lib/webhook-dedupe.ts': 'last-resort fallback',
  // MemoryIdempotencyStore: last fallback after Redis and Postgres (#23).
  'middleware/idempotency.ts': 'last-resort fallback',
  // Installation-token cache memory backend: tests / PLATFORM_STATE_STORE=memory only; Redis otherwise (#35).
  'lib/github-app.ts': 'test double (Redis in deployments)',
  // Pure graph builder: call-scoped node/edge indexes for one topology response (#31).
  'lib/topology.ts': 'request-scoped',
  // Folds one ingest batch into aggregate rows before the Postgres upsert (heatmaps).
  'lib/heatmaps.ts': 'request-scoped',
  // Bounded write-behind buffer of additive heatmap count increments (max keys, flushed every
  // HEATMAP_FLUSH_MS and on shutdown). Not shared state: each replica adds its own deltas with
  // count = count + EXCLUDED.count, so Postgres totals stay exact across replicas; a hard crash
  // loses at most one flush interval of this process's counts (docs/guides/heatmaps.md).
  'lib/heatmap-buffer.ts': 'bounded write-behind aggregation buffer',
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
