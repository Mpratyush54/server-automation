import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { ReplaysComponent } from './replays.component';
import { ReplayPlayerComponent, ReplayPlayerLike } from './replay-player.component';
import { browserLabel, formatDuration, listParams, mergeChunkEvents, replayMarkers } from './replay-utils';

const P = '11111111-1111-4111-8111-111111111111';
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';

function route(params: Record<string, string>) {
  return { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(params), queryParamMap: convertToParamMap({}) } } };
}

const row = {
  session_id: SID, environment: 'production', release: '1.2.3', app: 'web', user_id: null,
  user_agent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  first_page: '/orders/42', pages: ['/orders/42', '/checkout'], trace_ids: [], started_at: '2026-11-10T10:00:00Z',
  ended_at: '2026-11-10T10:01:05Z', duration_ms: '65000', chunk_count: 2, event_count: 10, bytes: 2048,
  error_count: 1, network_error_count: 0, viewport_width: 1280, viewport_height: 720,
};

describe('replay helpers', () => {
  it('builds list query params from the filters', () => {
    expect(listParams({ page: ' /checkout ', errors: 'true', minDurationSec: 5, maxDurationSec: null, environment: '' }, 50))
      .toEqual({ limit: '50', offset: '50', page: '/checkout', errors: 'true', minDurationMs: '5000' });
  });

  it('formats durations and browsers', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration('3600000')).toBe('1h 0m');
    expect(browserLabel(row.user_agent)).toBe('Chrome · Windows');
    expect(browserLabel(null)).toBe('—');
  });

  it('merges chunks in seq order and sorts events by time', () => {
    const events = mergeChunkEvents([
      { seq: 1, events: [{ type: 3, timestamp: 30 }, { type: 3, timestamp: 20 }] },
      null,
      { seq: 0, events: [{ type: 4, timestamp: 10 }, { type: 2, timestamp: 10 }] },
    ]);
    expect(events.map((e) => e.timestamp)).toEqual([10, 10, 20, 30]);
    expect(events[0].type).toBe(4); // stable: Meta stays before FullSnapshot
  });

  it('builds error / network / navigation markers and places linked errors on the timeline', () => {
    const events = [
      { type: 4, timestamp: 1000 },
      { type: 5, timestamp: 3000, data: { tag: 'network', payload: { method: 'GET', url: 'https://api/x', status: 503, durationMs: 12, traceId: 'a'.repeat(32), failed: true } } },
      { type: 5, timestamp: 4000, data: { tag: 'error', payload: { type: 'TypeError', message: 'x is undefined' } } },
      { type: 5, timestamp: 2000, data: { tag: 'navigation', payload: { path: '/checkout' } } },
      { type: 3, timestamp: 9000 },
    ];
    const m = replayMarkers(events, [{ id: 'e1', issue_id: 'i1', received_at: new Date(5000).toISOString(), title: 'TypeError: boom', type: 'TypeError', message: 'boom', trace_id: null, release: '1' }]);
    expect(m.map((x) => [x.kind, x.offsetMs])).toEqual([['network', 2000], ['navigation', 1000], ['error', 3000], ['error', 4000]].sort((a, b) => (a[1] as number) - (b[1] as number)) as any);
    expect(m.find((x) => x.kind === 'network')!.traceId).toBe('a'.repeat(32));
    expect(m.find((x) => x.issueId)!.issueId).toBe('i1');
  });
});

describe('ReplaysComponent', () => {
  it('loads sessions for the project and renders rows with filters', async () => {
    TestBed.configureTestingModule({ imports: [ReplaysComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), route({ id: P })] });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ReplaysComponent);
    fixture.detectChanges();
    const req = http.expectOne((r) => r.url === `/api/projects/${P}/replays`);
    expect(req.request.params.get('limit')).toBe('50');
    req.flush({ enabled: true, sessions: [row] });
    await fixture.whenStable();
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-test="session-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('/orders/42');
    expect(rows[0].textContent).toContain('1m 5s');
    expect(rows[0].querySelector('a.btn').getAttribute('href')).toBe(`/projects/${P}/replays/${SID}`);

    const cmp = fixture.componentInstance;
    cmp.filters.errors = 'true';
    cmp.filters.page = '/checkout';
    void cmp.load();
    const filtered = http.expectOne((r) => r.url === `/api/projects/${P}/replays`);
    expect(filtered.request.params.get('errors')).toBe('true');
    expect(filtered.request.params.get('page')).toBe('/checkout');
    filtered.flush({ enabled: false, sessions: [] });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="empty"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-test="disabled"]')).toBeTruthy();
    http.verify();
  });
});

describe('ReplayPlayerComponent', () => {
  it('fetches chunks, builds markers and starts the player with merged events', async () => {
    TestBed.configureTestingModule({ imports: [ReplayPlayerComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), route({ id: P, sessionId: SID })] });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ReplayPlayerComponent);
    const created: Array<Record<string, unknown>> = [];
    const gotos: number[] = [];
    let destroyed = false;
    fixture.componentInstance.playerFactory = async () => (_target, props) => {
      created.push(props);
      const p: ReplayPlayerLike = { goto: (t) => gotos.push(t), $destroy: () => (destroyed = true) };
      return p;
    };
    fixture.detectChanges();
    http.expectOne(`/api/projects/${P}/replays/${SID}`).flush({
      session: row,
      chunks: [{ seq: 0, bytes: 1, event_count: 2, started_at: '', ended_at: '' }, { seq: 1, bytes: 1, event_count: 1, started_at: '', ended_at: '' }],
      errors: [],
    });
    await new Promise((r) => setTimeout(r));
    http.expectOne(`/api/projects/${P}/replays/${SID}/chunks/0`).flush({ v: 1, seq: 0, events: [{ type: 4, timestamp: 1000, data: {} }, { type: 2, timestamp: 1001, data: {} }] });
    http.expectOne(`/api/projects/${P}/replays/${SID}/chunks/1`).flush({ v: 1, seq: 1, events: [{ type: 5, timestamp: 9000, data: { tag: 'error', payload: { type: 'Error', message: 'boom' } } }] });
    for (let i = 0; i < 5 && !created.length; i++) await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    expect(created.length).toBe(1);
    expect((created[0]['events'] as any[]).length).toBe(3);
    expect(created[0]['tags']).toEqual(jasmine.objectContaining({ error: '#ef4444' }));
    const markers = fixture.nativeElement.querySelectorAll('[data-test="marker"]');
    expect(markers.length).toBe(1);
    (markers[0].querySelector('button') as HTMLButtonElement).click();
    expect(gotos).toEqual([6000]); // 2 s before the error at 8 s
    fixture.destroy();
    expect(destroyed).toBeTrue();
    http.verify();
  });

  it('explains when a recording cannot be played', async () => {
    TestBed.configureTestingModule({ imports: [ReplayPlayerComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), route({ id: P, sessionId: SID })] });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ReplayPlayerComponent);
    fixture.componentInstance.playerFactory = async () => { throw new Error('must not load the player'); };
    fixture.detectChanges();
    http.expectOne(`/api/projects/${P}/replays/${SID}`).flush({ error: 'Replay not found' }, { status: 404, statusText: 'Not Found' });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Replay not found');
  });
});
