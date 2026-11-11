import { buildWaterfall, chartPaths, flameRects, fmtDuration, fmtMs, fmtPct, fmtRate, humanizeStatus, isProjectTab, isSince, layoutGraph, nsToDate, rangeNotice, Span } from './observability-api';

describe('range clamp notice (#48)', () => {
  it('formats durations', () => {
    expect(fmtDuration(604_800)).toBe('7 d');
    expect(fmtDuration(86_400)).toBe('1 d');
    expect(fmtDuration(86_340)).toBe('23 h 59 min');
    expect(fmtDuration(900)).toBe('15 min');
    expect(fmtDuration(30)).toBe('30 s');
  });

  it('only reports clamped ranges, ignoring sub-1% trims', () => {
    expect(rangeNotice(null)).toBe('');
    expect(rangeNotice({ start: 0, end: 3600, clamped: false }, 3600)).toBe('');
    expect(rangeNotice({ start: 0, end: 259_200, clamped: true }, 604_800)).toBe('Range shortened to 3 d');
    expect(rangeNotice({ start: 0, end: 86_340, clamped: true }, 86_400)).toBe('');
    expect(rangeNotice({ start: 0, end: 86_340, clamped: true })).toBe('Range shortened to 23 h 59 min');
  });
});

function span(id: string, parent: string | null, start: number, end: number, extra: Partial<Span> = {}): Span {
  return {
    spanId: id, parentSpanId: parent, name: id, kind: 'SERVER', serviceName: 'svc',
    startTimeUnixNano: String(start * 1_000_000), endTimeUnixNano: String(end * 1_000_000), durationMs: end - start,
    status: { code: 'UNSET', message: null }, attributes: {}, ...extra,
  };
}

describe('observability helpers (#48)', () => {
  it('waterfall: depth-first from roots; spans whose parent is hidden become roots', () => {
    const { rows, durationMs } = buildWaterfall([
      span('child2', 'root', 50, 90),
      span('root', null, 0, 100),
      span('child1', 'root', 10, 40, { status: { code: 'ERROR', message: 'boom' } }),
      span('grandchild', 'child1', 20, 30),
      span('orphan', 'hidden-span-of-other-project', 60, 70),
    ]);
    expect(rows.map((r) => [r.span.spanId, r.depth])).toEqual([
      ['root', 0], ['child1', 1], ['grandchild', 2], ['child2', 1], ['orphan', 0],
    ]);
    expect(durationMs).toBe(100);
    const c1 = rows.find((r) => r.span.spanId === 'child1')!;
    expect(c1.offset).toBeCloseTo(10);
    expect(c1.width).toBeCloseTo(30);
    expect(c1.error).toBeTrue();
    expect(buildWaterfall([]).rows).toEqual([]);
  });

  it('waterfall survives parent cycles', () => {
    const { rows } = buildWaterfall([span('a', 'b', 0, 10), span('b', 'a', 0, 10), span('c', null, 0, 5)]);
    expect(rows.map((r) => r.span.spanId)).toEqual(['c']);
  });

  it('service map layout places callers left of callees', () => {
    const g = layoutGraph(
      [{ id: 'web', external: false, virtual: false }, { id: 'api', external: false, virtual: false }, { id: 'db', external: false, virtual: true }],
      [{ source: 'web', target: 'api', requestRate: 1, errorRate: 0 }, { source: 'api', target: 'db', requestRate: 1, errorRate: 0 }],
    );
    const x = Object.fromEntries(g.nodes.map((n) => [n.id, n.x]));
    expect(x['web']).toBeLessThan(x['api']);
    expect(x['api']).toBeLessThan(x['db']);
    expect(g.width).toBeGreaterThan(x['db']);
  });

  it('flame graph decodes delta-encoded flamebearer levels', () => {
    const rects = flameRects({
      names: ['total', 'main', 'work', 'idle'],
      levels: [[0, 100, 0, 0], [0, 100, 10, 1], [0, 60, 60, 2, 10, 30, 30, 3]],
      numTicks: 100, maxSelf: 60,
    });
    const work = rects.find((r) => r.name === 'work')!;
    const idle = rects.find((r) => r.name === 'idle')!;
    expect(work).toEqual(jasmine.objectContaining({ level: 2, start: 0, width: 0.6 }));
    expect(idle.start).toBeCloseTo(0.7);
    expect(idle.width).toBeCloseTo(0.3);
  });

  it('chart paths leave gaps for missing points and share one y scale', () => {
    const g = chartPaths([[[0, 1], [10, null], [20, 2]], [[0, 0], [20, 4]]], 100, 50);
    expect(g.paths[0].match(/M/g)!.length).toBe(2);
    expect(g.yMax).toBeCloseTo(4.4);
    expect(g.tMin).toBe(0);
    expect(g.tMax).toBe(20);
  });

  it('formats numbers and validates URL state', () => {
    expect(fmtRate(0.5)).toBe('30.0/min');
    expect(fmtRate(12.34)).toBe('12.3/s');
    expect(fmtPct(1.234)).toBe('1.23%');
    expect(fmtMs(1500)).toBe('1.50 s');
    expect(fmtMs(null)).toBe('—');
    expect(nsToDate('1700000000000000000')!.getTime()).toBe(1700000000000);
    expect(isProjectTab('traces')).toBeTrue();
    expect(isProjectTab('evil')).toBeFalse();
    expect(isSince('7d')).toBeTrue();
    expect(isSince('100y')).toBeFalse();
  });

  it('humanizes status enums', () => {
    expect(humanizeStatus('major_outage')).toBe('Major outage');
    expect(humanizeStatus('operational')).toBe('Operational');
    expect(humanizeStatus('partial-outage')).toBe('Partial outage');
    expect(humanizeStatus(null)).toBe('');
    expect(humanizeStatus('')).toBe('');
  });
});
