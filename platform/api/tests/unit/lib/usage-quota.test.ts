import { setAlertEventTestHook } from '../../../src/lib/alert-events';
import {
  breachToAlertEvent,
  parseQuotaBody,
  parseResourceQuota,
  quotaBars,
  quotaBreaches,
  quotaDedupeKey,
  resolveQuotaAlert,
  usageAgainstQuota,
} from '../../../src/lib/usage-quota';

describe('usage quota thresholds', () => {
  afterEach(() => setAlertEventTestHook(null));

  it('fires warning at 80% and critical at 100%', () => {
    const used = usageAgainstQuota({
      cpuCoreHours: 80,
      memoryGbHours: 100,
      pvcStorageGb: 4,
      objectStorageGb: 1,
      ingressBandwidthGb: 50,
      buildMinutes: 10,
    });
    const breaches = quotaBreaches(used, {
      cpuCoreHours: 100,
      memoryGbHours: 100,
      storageGb: 10,
      bandwidthGb: 100,
      buildMinutes: null,
      resourceQuota: null,
      alertsEnabled: true,
    });
    expect(breaches).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'cpuCoreHours', level: 'warning', ratio: 0.8 }),
      expect.objectContaining({ metric: 'memoryGbHours', level: 'critical', ratio: 1 }),
    ]));
    expect(breaches.find((b) => b.metric === 'storageGb')).toBeUndefined();
    expect(breaches.find((b) => b.metric === 'buildMinutes')).toBeUndefined();
  });

  it('builds alert events and resolve events with stable dedupe keys', () => {
    const events: any[] = [];
    setAlertEventTestHook((e) => events.push(e));
    const breach = quotaBreaches(
      { cpuCoreHours: 100, memoryGbHours: 0, storageGb: 0, bandwidthGb: 0, buildMinutes: 0 },
      { cpuCoreHours: 100, memoryGbHours: null, storageGb: null, bandwidthGb: null, buildMinutes: null, resourceQuota: null, alertsEnabled: true },
    )[0];
    const firing = breachToAlertEvent('11111111-1111-4111-8111-111111111111', breach);
    expect(firing.source).toBe('usage');
    expect(firing.severity).toBe('critical');
    expect(firing.dedupeKey).toBe(quotaDedupeKey('11111111-1111-4111-8111-111111111111', 'cpuCoreHours'));
    expect(firing.url).toContain('view=usage');

    const resolved = resolveQuotaAlert('11111111-1111-4111-8111-111111111111', 'cpuCoreHours');
    expect(resolved.status).toBe('resolved');
    expect(resolved.dedupeKey).toBe(firing.dedupeKey);
  });

  it('exposes quota bar percents for the portal', () => {
    const bars = quotaBars(
      { cpuCoreHours: 40, memoryGbHours: 0, storageGb: 0, bandwidthGb: 0, buildMinutes: 0 },
      { cpuCoreHours: 100, memoryGbHours: null, storageGb: null, bandwidthGb: null, buildMinutes: null, resourceQuota: null, alertsEnabled: true },
    );
    expect(bars.cpuCoreHours.percent).toBe(40);
    expect(bars.memoryGbHours.percent).toBeNull();
  });

  it('parses ResourceQuota overrides and rejects unknown keys', () => {
    expect(parseResourceQuota({ 'requests.cpu': '2', 'requests.memory': '4Gi' })).toEqual({
      'requests.cpu': '2',
      'requests.memory': '4Gi',
    });
    expect(() => parseResourceQuota({ 'requests.gpu': '1' })).toThrow(/unsupported/);
    expect(parseQuotaBody({ cpuCoreHours: 10, alertsEnabled: false, resourceQuota: { pods: '20' } })).toMatchObject({
      cpuCoreHours: 10,
      alertsEnabled: false,
      resourceQuota: { pods: '20' },
    });
  });

  it('skips alerts when disabled', () => {
    expect(quotaBreaches(
      { cpuCoreHours: 999, memoryGbHours: 0, storageGb: 0, bandwidthGb: 0, buildMinutes: 0 },
      { cpuCoreHours: 1, memoryGbHours: null, storageGb: null, bandwidthGb: null, buildMinutes: null, resourceQuota: null, alertsEnabled: false },
    )).toEqual([]);
  });
});
