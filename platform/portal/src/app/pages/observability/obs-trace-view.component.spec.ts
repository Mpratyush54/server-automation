import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SimpleChange } from '@angular/core';
import { ObsTraceViewComponent } from './obs-trace-view.component';
import { ObsLogsComponent } from './obs-logs.component';
import { ObsFlamegraphComponent } from './obs-flamegraph.component';
import { ObsServiceMapComponent } from './obs-service-map.component';

const PID = '11111111-1111-4111-8111-111111111111';
const TID = 'abcdef0123456789abcdef0123456789';
const span = (id: string, parent: string | null, start: number, end: number, code = 'UNSET') => ({
  spanId: id, parentSpanId: parent, name: `op-${id}`, kind: 'SERVER', serviceName: 'checkout',
  startTimeUnixNano: String(start * 1e6), endTimeUnixNano: String(end * 1e6), durationMs: end - start,
  status: { code, message: code === 'ERROR' ? 'boom' : null }, attributes: { 'http.route': '/pay' },
});

describe('observability detail components (#48)', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('trace view renders the waterfall, hidden span count and log link', async () => {
    const fixture = TestBed.createComponent(ObsTraceViewComponent);
    const c = fixture.componentInstance;
    c.projectId = PID;
    c.traceId = TID;
    const logs = spyOn(c.logsForTrace, 'emit');
    const load = c.load();
    TestBed.inject(HttpTestingController).expectOne(`/api/projects/${PID}/observability/traces/${TID}`)
      .flush({ traceId: TID, spans: [span('a', null, 0, 100), span('b', 'a', 10, 60, 'ERROR')], hiddenSpans: 3, truncated: false });
    await load;
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('.wf-row').length).toBe(2);
    expect(el.querySelectorAll('.wf-bar.error').length).toBe(1);
    expect(el.textContent).toContain('3 spans from other projects hidden');
    expect(el.textContent).toContain('/pay');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Logs for this trace')) as HTMLButtonElement).click();
    expect(logs).toHaveBeenCalledWith(TID);
  });

  it('trace view: 404 shows a not-found message', async () => {
    const fixture = TestBed.createComponent(ObsTraceViewComponent);
    const c = fixture.componentInstance;
    c.projectId = PID;
    c.traceId = TID;
    const load = c.load();
    TestBed.inject(HttpTestingController).expectOne(() => true).flush({ error: 'Trace not found' }, { status: 404, statusText: 'Not Found' });
    await load;
    expect(c.error).toContain('not found');
  });

  it('logs explorer filters by trace id, links lines to traces and tails with a cursor', async () => {
    const fixture = TestBed.createComponent(ObsLogsComponent);
    const c = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    c.projectId = PID;
    c.traceId = TID;
    const open = spyOn(c.openTrace, 'emit');
    c.ngOnChanges({ traceId: new SimpleChange('', TID, true) });
    const req = http.expectOne((r) => r.url === `/api/projects/${PID}/observability/query/loki`);
    expect(req.request.params.get('traceId')).toBe(TID);
    req.flush({ resultType: 'streams', entries: [{ ts: '1700000000000000002', line: 'paid', labels: { service_name: 'checkout' }, traceId: TID, spanId: null }] });
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('paid');
    (Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Trace') as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(TID);

    const tail = c.tail();
    const t = http.expectOne((r) => r.url.endsWith('/query/loki'));
    expect(t.request.params.get('after')).toBe('1700000000000000002');
    expect(t.request.params.get('direction')).toBe('forward');
    t.flush({ entries: [{ ts: '1700000000000000003', line: 'newer', labels: {}, traceId: null, spanId: null }] });
    await tail;
    expect(c.entries.map((e) => e.line)).toEqual(['newer', 'paid']);
    c.ngOnDestroy();
  });

  it('flame graph renders frames and zooms', () => {
    const fixture = TestBed.createComponent(ObsFlamegraphComponent);
    const c = fixture.componentInstance;
    c.flamebearer = { names: ['total', 'main', 'work'], levels: [[0, 100, 0, 0], [0, 100, 40, 1], [0, 60, 60, 2]], numTicks: 100, maxSelf: 60 };
    c.ngOnChanges();
    fixture.detectChanges();
    const frames = (fixture.nativeElement as HTMLElement).querySelectorAll('.fr');
    expect(frames.length).toBe(3);
    c.zoomTo(c.rects.find((r) => r.name === 'work')!);
    expect(c.view.length).toBe(1);
    expect(c.view[0].width).toBeCloseTo(100);
    c.reset();
    expect(c.view.length).toBe(3);
  });

  it('service map renders nodes and marks other projects', () => {
    const fixture = TestBed.createComponent(ObsServiceMapComponent);
    const c = fixture.componentInstance;
    c.nodes = [{ id: 'checkout', external: false, virtual: false }, { id: '(other project)', external: true, virtual: false }];
    c.edges = [{ source: 'checkout', target: '(other project)', requestRate: 2, errorRate: 0 }];
    c.ngOnChanges();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('g.node').length).toBe(2);
    expect(el.querySelectorAll('g.node.external').length).toBe(1);
    expect(el.querySelectorAll('path.edge').length).toBe(1);
  });
});
