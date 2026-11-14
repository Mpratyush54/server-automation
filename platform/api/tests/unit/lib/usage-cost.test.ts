import { allocateServerCost, directCost, parsePrices, usageCsv } from '../../../src/lib/usage-cost';
import { EMPTY_METRICS } from '../../../src/lib/usage-metrics';

const prices = parsePrices({
  perCoreHour: 0.10,
  perGbHourMemory: 0.01,
  perGbMonthStorage: 3.0, // $3/GB-month → $0.10/GB-day
  perGbBandwidth: 0.05,
  perBuildMinute: 0.02,
  monthlyServerCost: 300,
  currency: 'usd',
});

describe('usage cost allocation', () => {
  it('computes direct cost from unit prices', () => {
    const cost = directCost({
      cpuCoreHours: 10,
      memoryGbHours: 20,
      pvcStorageGb: 2,
      objectStorageGb: 1,
      ingressBandwidthGb: 4,
      buildMinutes: 5,
    }, prices, 1);
    // cpu 1.0 + mem 0.2 + storage (3 GB * 3/30) 0.3 + bw 0.2 + build 0.1 = 1.8
    expect(cost.cpu).toBeCloseTo(1, 4);
    expect(cost.memory).toBeCloseTo(0.2, 4);
    expect(cost.storage).toBeCloseTo(0.3, 4);
    expect(cost.bandwidth).toBeCloseTo(0.2, 4);
    expect(cost.build).toBeCloseTo(0.1, 4);
    expect(cost.total).toBeCloseTo(1.8, 4);
    expect(cost.serverShare).toBe(0);
  });

  it('allocates monthly server cost by compute weight over the period', () => {
    const rows = allocateServerCost([
      { metrics: { ...EMPTY_METRICS, cpuCoreHours: 75 }, cost: directCost({ ...EMPTY_METRICS, cpuCoreHours: 75 }, prices) },
      { metrics: { ...EMPTY_METRICS, cpuCoreHours: 25 }, cost: directCost({ ...EMPTY_METRICS, cpuCoreHours: 25 }, prices) },
    ], prices, 30);
    // Full month: $300 split 75/25.
    expect(rows[0].cost.serverShare).toBeCloseTo(225, 2);
    expect(rows[1].cost.serverShare).toBeCloseTo(75, 2);
    expect(rows[0].cost.total).toBeGreaterThan(rows[0].cost.cpu);
  });

  it('splits server cost equally when nothing was metered', () => {
    const rows = allocateServerCost([
      { metrics: { ...EMPTY_METRICS }, cost: directCost(EMPTY_METRICS, prices) },
      { metrics: { ...EMPTY_METRICS }, cost: directCost(EMPTY_METRICS, prices) },
    ], { ...prices, monthlyServerCost: 100 }, 30);
    expect(rows[0].cost.serverShare).toBeCloseTo(50, 2);
    expect(rows[1].cost.serverShare).toBeCloseTo(50, 2);
  });

  it('parses prices with safe defaults and uppercases currency', () => {
    expect(parsePrices({ currency: 'eur', perCoreHour: -1 }).perCoreHour).toBe(0.04);
    expect(parsePrices({ currency: 'eur' }).currency).toBe('EUR');
  });

  it('renders CSV with cost column', () => {
    const csv = usageCsv([{
      day: '2026-03-01',
      projectId: 'p1',
      projectName: 'shop',
      environmentName: 'production',
      namespace: 'shop-prod',
      metrics: { ...EMPTY_METRICS, cpuCoreHours: 1 },
      cost: directCost({ ...EMPTY_METRICS, cpuCoreHours: 1 }, prices),
    }]);
    expect(csv.split('\n')[0]).toContain('estimatedCost');
    expect(csv).toContain('shop');
    expect(csv).toContain('production');
  });
});

describe('usageCsv formula safety', () => {
  it('neutralises text cells that spreadsheets would run as formulas', () => {
    const { usageCsv } = require('../../../src/lib/usage-cost');
    const metrics = { cpuCoreHours: 1, memoryGbHours: 1, pvcStorageGb: 0, objectStorageGb: 0, ingressBandwidthGb: 0, buildMinutes: 0 };
    const csv: string = usageCsv([{ day: '2026-11-01', projectId: 'p', projectName: '=HYPERLINK("x")', environmentName: 'prod', namespace: 'ns', metrics }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toContain(',=HYPERLINK');
  });
});
