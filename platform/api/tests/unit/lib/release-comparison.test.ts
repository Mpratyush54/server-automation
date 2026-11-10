import { summarizeReleaseWindow, releaseDelta } from '../../../src/lib/release-comparison';
import { releaseEnv, releaseVersion } from '../../../src/lib/release-version';
const samples = (durationMs: number) => Array.from({length:100}, (_,i) => ({ durationMs, statusCode: i < 5 ? 500 : 200, timestamp: new Date() }));
it('shows a latency regression, request weighted errors and throughput', () => {
  const before = summarizeReleaseWindow(samples(20), 60, 1);
  const after = summarizeReleaseWindow(samples(80), 60, 3);
  expect(before.errorRate).toBe(5);
  expect(before.throughputRps).toBeCloseTo(100/60);
  expect(releaseDelta(before.p95LatencyMs, after.p95LatencyMs)).toEqual({ absolute:60, percent:300 });
  expect(after.newErrorIssues).toBe(3);
});
it('does not invent latency/error data or percent change from zero', () => {
  expect(summarizeReleaseWindow([],60,0)).toMatchObject({p95LatencyMs:null,errorRate:null,throughputRps:0,webVitals:null});
  expect(releaseDelta(0,10)).toEqual({absolute:10,percent:null});
  expect(releaseDelta(null,10)).toEqual({absolute:null,percent:null});
});
it('computes nearest-rank p95 over individual samples', () => {
  const data = samples(20); data[99].durationMs=10000;
  expect(summarizeReleaseWindow(data,60,0).p95LatencyMs).toBe(20);
});
it('merges attributes without retaining a stale service version', () => {
  const env = releaseEnv('abc123',[{name:'OTEL_RESOURCE_ATTRIBUTES',value:'team=ops,service.version=old'}]);
  expect(env).toContainEqual({name:'PLATFORM_RELEASE',value:'abc123'});
  expect(env).toContainEqual({name:'OTEL_RESOURCE_ATTRIBUTES',value:'team=ops,service.version=abc123'});
  expect(releaseEnv('abc123',env)).toEqual(env);
});
it('uses SHA then image tag and rejects resource attribute injection', () => {
  expect(releaseVersion({commitSha:'abc123',imageTag:'v2'})).toBe('abc123');
  expect(releaseVersion({commitSha:'unknown',imageTag:'v2'})).toBe('v2');
  expect(() => releaseEnv('v2,team=evil')).toThrow();
  expect(() => releaseEnv('v2',[{name:'OTEL_RESOURCE_ATTRIBUTES',valueFrom:{secretKeyRef:{}}}])).toThrow();
});
