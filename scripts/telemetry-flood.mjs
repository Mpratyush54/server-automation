#!/usr/bin/env node
/**
 * Telemetry flood vs API latency (issue #49 acceptance: under a telemetry flood the
 * portal/API p95 stays within 20% of baseline). NOT run in CI — run it against a real
 * install (see docs/architecture/telemetry-ingestion.md, "Load test").
 *
 * 1. Baseline: probe a portal/API endpoint for DURATION seconds, record latencies.
 * 2. Flood: same probe while FLOOD_CONCURRENCY workers POST log batches to /api/sdk/logs
 *    (and api-metrics) as fast as the API accepts them (202 queued / 429 backpressure).
 * 3. Print p50/p95/p99 for both phases, the p95 ratio and ingest status counts.
 *
 * Environment:
 *   PLATFORM_URL        https://platform.<domain>   (required)
 *   SDK_TOKEN           sdk_live_…  SDK token of a throwaway project (required)
 *   PROJECT_ID          that project's id (required)
 *   PROBE_PATH          default /api/health/ready (use /api/projects with PROBE_TOKEN for an authenticated portal call)
 *   PROBE_TOKEN         optional bearer token for the probe (portal JWT)
 *   DURATION            seconds per phase (default 30)
 *   PROBE_CONCURRENCY   parallel probe loops (default 2)
 *   FLOOD_CONCURRENCY   parallel flood workers (default 50)
 *   BATCH               log entries per request (default 100)
 *   MAX_P95_RATIO       pass threshold (default 1.2); exit code 1 when exceeded
 */

const env = process.env;
const BASE = (env.PLATFORM_URL || '').replace(/\/+$/, '');
const SDK_TOKEN = env.SDK_TOKEN || '';
const PROJECT_ID = env.PROJECT_ID || '';
if (!BASE || !SDK_TOKEN || !PROJECT_ID) {
  console.error('PLATFORM_URL, SDK_TOKEN and PROJECT_ID are required');
  process.exit(2);
}
const PROBE_PATH = env.PROBE_PATH || '/api/health/ready';
const PROBE_TOKEN = env.PROBE_TOKEN || '';
const DURATION_MS = Number(env.DURATION || 30) * 1000;
const PROBE_CONCURRENCY = Number(env.PROBE_CONCURRENCY || 2);
const FLOOD_CONCURRENCY = Number(env.FLOOD_CONCURRENCY || 50);
const BATCH = Number(env.BATCH || 100);
const MAX_P95_RATIO = Number(env.MAX_P95_RATIO || 1.2);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function probeLoop(until, out) {
  while (Date.now() < until) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}${PROBE_PATH}`, {
        headers: PROBE_TOKEN ? { Authorization: `Bearer ${PROBE_TOKEN}` } : {},
      });
      await res.arrayBuffer();
      out.push({ ms: performance.now() - t0, status: res.status });
    } catch {
      out.push({ ms: performance.now() - t0, status: 0 });
    }
    await sleep(50);
  }
}

function logBatch(i) {
  const now = new Date().toISOString();
  return {
    logs: Array.from({ length: BATCH }, (_, j) => ({
      level: j % 10 === 0 ? 'ERROR' : 'INFO',
      message: `flood ${i}-${j} ${'x'.repeat(80)}`,
      environment: 'loadtest',
      timestamp: now,
      fields: { stackHash: `h${j % 5}`, errorType: 'LoadTest' },
    })),
  };
}

async function floodLoop(until, counts, worker) {
  let i = 0;
  while (Date.now() < until) {
    const metrics = i % 5 === 4;
    const url = metrics ? '/api/sdk/api-metrics' : '/api/sdk/logs';
    const body = metrics
      ? { projectId: PROJECT_ID, metrics: Array.from({ length: BATCH }, () => ({ route: '/load', method: 'GET', statusCode: 200, durationMs: 5, environment: 'loadtest' })) }
      : logBatch(`${worker}-${i}`);
    try {
      const res = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SDK_TOKEN}` },
        body: JSON.stringify(body),
      });
      await res.arrayBuffer();
      counts[res.status] = (counts[res.status] || 0) + 1;
      if (res.status === 429) {
        // Honour Retry-After with jitter, like the SDKs.
        const ra = Number(res.headers.get('retry-after')) || 1;
        await sleep(ra * 1000 * (0.5 + Math.random()));
      }
    } catch {
      counts.error = (counts.error || 0) + 1;
      await sleep(200);
    }
    i++;
  }
}

function summary(name, samples) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 500).map((s) => s.ms).sort((a, b) => a - b);
  const failed = samples.length - ok.length;
  const r = { name, n: samples.length, failed, p50: pct(ok, 50), p95: pct(ok, 95), p99: pct(ok, 99) };
  console.log(`${name.padEnd(9)} n=${r.n} failed=${failed} p50=${r.p50.toFixed(1)}ms p95=${r.p95.toFixed(1)}ms p99=${r.p99.toFixed(1)}ms`);
  return r;
}

async function phase(withFlood) {
  const until = Date.now() + DURATION_MS;
  const samples = [];
  const counts = {};
  const jobs = Array.from({ length: PROBE_CONCURRENCY }, () => probeLoop(until, samples));
  if (withFlood) for (let w = 0; w < FLOOD_CONCURRENCY; w++) jobs.push(floodLoop(until, counts, w));
  await Promise.all(jobs);
  return { samples, counts };
}

console.log(`probe ${BASE}${PROBE_PATH}; ${DURATION_MS / 1000}s per phase; flood ${FLOOD_CONCURRENCY} workers x ${BATCH} entries`);
const base = summary('baseline', (await phase(false)).samples);
const flood = await phase(true);
const under = summary('flood', flood.samples);
console.log('ingest responses:', JSON.stringify(flood.counts));
const ratio = under.p95 / base.p95;
console.log(`p95 ratio ${ratio.toFixed(2)} (limit ${MAX_P95_RATIO})`);
console.log('Queue metrics: GET /api/metrics/jobs (DevOps) → platform_telemetry_queue_depth, _lag_seconds, _events_dropped_total');
process.exit(ratio <= MAX_P95_RATIO ? 0 : 1);
