import {
  assembleEnvMetrics,
  bytesToGb,
  coreSecondsToHours,
  dayWindow,
  memoryBytesToGbHours,
  metricsFromPromVectors,
  previousUtcDay,
  promRegex,
  sumRollupMetrics,
  usageQueries,
  utcDay,
} from '../../../src/lib/usage-metrics';

describe('usage-metrics rollup math', () => {
  it('converts core-seconds and memory bytes into billing units', () => {
    expect(coreSecondsToHours(7200)).toBe(2);
    expect(memoryBytesToGbHours(2 * 1024 ** 3, 24)).toBe(48);
    expect(bytesToGb(5 * 1024 ** 3)).toBe(5);
  });

  it('builds PromQL scoped to the given namespaces and hosts', () => {
    const q = usageQueries(['shop-prod-abc', 'shop-stg-def'], ['shop-prod-abc.example.com']);
    expect(q.cpu).toContain('namespace=~"shop-prod-abc|shop-stg-def"');
    expect(q.cpu).toContain('container_cpu_usage_seconds_total');
    expect(q.memory).toContain('container_memory_working_set_bytes');
    expect(q.pvc).toContain('kubelet_volume_stats_used_bytes');
    expect(q.ingress).toContain('nginx_ingress_controller_bytes_sent');
    expect(q.ingress).toContain('shop-prod-abc\\.example\\.com');
  });

  it('escapes regex metacharacters in label matchers', () => {
    expect(promRegex(['a.b', 'c|d'])).toBe('a\\.b|c\\|d');
  });

  it('aggregates fixed Prometheus vectors within 5% of expected core-hours', () => {
    // 1.5 cores average over a day ≈ 1.5 * 86400 core-seconds.
    const cpuSeconds = 1.5 * 86_400;
    const { byNamespace, byHost } = metricsFromPromVectors({
      cpuByNs: new Map([['ns-a', cpuSeconds], ['ns-b', 3600]]),
      memoryBytesByNs: new Map([['ns-a', 4 * 1024 ** 3], ['ns-b', 1024 ** 3]]),
      pvcBytesByNs: new Map([['ns-a', 10 * 1024 ** 3]]),
      ingressBytesByHost: new Map([['a.example.com', 2 * 1024 ** 3]]),
      hours: 24,
    });
    const a = byNamespace.get('ns-a')!;
    expect(a.cpuCoreHours).toBeCloseTo(36, 5); // 1.5 * 24
    expect(a.memoryGbHours).toBeCloseTo(96, 5); // 4 GiB * 24 h
    expect(a.pvcStorageGb).toBeCloseTo(10, 5);
    expect(byHost.get('a.example.com')).toBeCloseTo(2, 5);

    // Acceptance: within 5% of a hand-computed Prometheus-equivalent.
    const expectedCpu = cpuSeconds / 3600;
    expect(Math.abs(a.cpuCoreHours - expectedCpu) / expectedCpu).toBeLessThan(0.05);
  });

  it('assembles per-environment metrics and sums rollups', () => {
    const { byNamespace, byHost } = metricsFromPromVectors({
      cpuByNs: new Map([['ns-a', 3600]]),
      memoryBytesByNs: new Map([['ns-a', 1024 ** 3]]),
      pvcBytesByNs: new Map([['ns-a', 1024 ** 3]]),
      ingressBytesByHost: new Map([['a.example.com', 1024 ** 3]]),
      hours: 24,
    });
    const m = assembleEnvMetrics({
      namespace: 'ns-a',
      host: 'a.example.com',
      byNamespace,
      byHost,
      objectStorageGb: 3,
      buildMinutes: 12,
    });
    expect(m).toMatchObject({
      cpuCoreHours: 1,
      memoryGbHours: 24,
      pvcStorageGb: 1,
      objectStorageGb: 3,
      ingressBandwidthGb: 1,
      buildMinutes: 12,
    });

    const summed = sumRollupMetrics([m, m], { storageMode: 'max' });
    expect(summed.cpuCoreHours).toBe(2);
    expect(summed.pvcStorageGb).toBe(1);
    expect(summed.objectStorageGb).toBe(3);
    expect(summed.ingressBandwidthGb).toBe(2);
  });

  it('computes UTC day windows', () => {
    expect(utcDay(new Date('2026-03-15T12:00:00Z'))).toBe('2026-03-15');
    expect(previousUtcDay(new Date('2026-03-15T00:30:00Z'))).toBe('2026-03-14');
    const w = dayWindow('2026-03-15');
    expect(w.end - w.start).toBe(86_400);
    expect(w.hours).toBe(24);
  });
});
