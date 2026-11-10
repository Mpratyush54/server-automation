export interface RequestSample { durationMs: number; statusCode: number; timestamp: Date; }
export function summarizeReleaseWindow(samples: RequestSample[], seconds: number, newIssues: number) {
  const valid = samples.filter(s => Number.isFinite(s.durationMs) && s.durationMs >= 0 && Number.isFinite(s.statusCode));
  const durations = valid.map(s => s.durationMs).sort((a,b) => a-b);
  return {
    requests: valid.length,
    errorRate: valid.length ? valid.filter(s => s.statusCode >= 500).length / valid.length * 100 : null,
    p95LatencyMs: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : null,
    throughputRps: seconds > 0 ? valid.length / seconds : null,
    newErrorIssues: newIssues,
    webVitals: null, // Faro's collector currently has no project-scoped vital query API.
  };
}
export function releaseDelta(before: number | null, after: number | null) {
  return { absolute: before === null || after === null ? null : after - before,
    percent: before === null || after === null || before === 0 ? null : (after - before) / before * 100 };
}
