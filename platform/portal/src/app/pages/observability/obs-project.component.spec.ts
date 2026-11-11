import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ObsProjectComponent, webVitalQuery } from './obs-project.component';

const PID = '11111111-1111-4111-8111-111111111111';
const BASE = `/api/projects/${PID}/observability`;
const EMPTY_SUMMARY = { health: 'unknown', red: null, incidents: { active: 0, critical: 0 }, errors: { open: 0, regressions: 0 }, synthetics: null, slos: [] };

async function next(http: HttpTestingController, url: string): Promise<TestRequest> {
  for (let i = 0; i < 50; i++) {
    const m = http.match((r) => r.url === url);
    if (m.length) return m[0];
    await new Promise((r) => setTimeout(r));
  }
  throw new Error(`no request to ${url}`);
}

describe('ObsProjectComponent (#48)', () => {
  function setup(query: Record<string, string> = {}) {
    TestBed.configureTestingModule({
      imports: [ObsProjectComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: PID }), queryParamMap: convertToParamMap(query) }, queryParamMap: of(convertToParamMap(query)) } },
      ],
    });
    const fixture = TestBed.createComponent(ObsProjectComponent);
    return { fixture, c: fixture.componentInstance, http: TestBed.inject(HttpTestingController) };
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  /** Starts ngOnInit (first change detection) and answers status + project. */
  async function boot(fixture: any, http: HttpTestingController, enabled: boolean) {
    fixture.detectChanges();
    (await next(http, '/api/observability/status')).flush({ enabled });
    (await next(http, `/api/projects/${PID}`)).flush({ id: PID, name: 'shop', environments: [{ name: 'production' }] });
  }

  it('telemetry disabled: empty state and no backend queries', async () => {
    const { fixture, c, http } = setup({ tab: 'apm' });
    await boot(fixture, http, false);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(c.tab).toBe('apm');
    expect(el.querySelector('[data-testid="telemetry-disabled"]')).not.toBeNull();
    http.expectNone((r) => r.url.startsWith(BASE));
  });

  it('reads tab, range and environment from the URL and renders the overview with links', async () => {
    const { fixture, c, http } = setup({ tab: 'overview', since: '6h', env: 'production' });
    await boot(fixture, http, true);
    const summary = await next(http, `${BASE}/summary`);
    expect(summary.request.params.get('since')).toBe('6h');
    expect(summary.request.params.get('environment')).toBe('production');
    summary.flush({ ...EMPTY_SUMMARY, health: 'healthy', red: { requestRate: 3, errorRate: 0.2, p95Ms: 80, apdex: 0.97 }, errors: { open: 2, regressions: 0 }, synthetics: 'operational' });
    (await next(http, `${BASE}/red`)).flush({ requestRate: [[1, 2], [2, 3]], errorRate: [[1, 0], [2, 1]], p95Ms: [[1, 50], [2, 80]] });
    (await next(http, `/api/projects/${PID}/releases`)).flush([{ markerAt: new Date(1500).toISOString(), release: 'v2' }]);
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Healthy');
    expect(el.textContent).toContain('80.0 ms');
    expect(c.markers.length).toBe(1);
    expect(el.querySelectorAll('app-obs-line-chart').length).toBe(3);
    // Links to errors (#41), synthetics (#42), alerting (#43), releases (#44).
    const links = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href') || '');
    expect(links.some((h) => h.includes(`/projects/${PID}/errors`))).toBeTrue();
    expect(links.some((h) => h.includes(`/projects/${PID}/synthetics`))).toBeTrue();
    expect(links.some((h) => h.includes('/alerting'))).toBeTrue();
    expect(links.some((h) => h.includes('tab=deployments'))).toBeTrue();
  });

  it('opening a trace puts it in the URL; logs for a trace switch to the logs tab', () => {
    const { c } = setup();
    c.projectId = PID;
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigate').and.resolveTo(true);
    spyOn(c, 'loadTab').and.resolveTo();
    c.openTrace('abcdef0123456789abcdef0123456789');
    expect(nav).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { tab: 'traces', trace: 'abcdef0123456789abcdef0123456789' }, queryParamsHandling: 'merge' }));
    expect(c.tab).toBe('traces');
    c.logsForTrace('abcdef0123456789abcdef0123456789');
    expect(c.tab).toBe('logs');
    expect(c.logTraceId).toBe('abcdef0123456789abcdef0123456789');
    expect(c.openTraceId).toBe('');
  });

  it('ignores invalid URL state', async () => {
    const { fixture, c, http } = setup({ tab: 'nope', since: '99y', trace: '"><script>' });
    await boot(fixture, http, true);
    (await next(http, `${BASE}/summary`)).flush(EMPTY_SUMMARY);
    (await next(http, `${BASE}/red`)).flush({});
    (await next(http, `/api/projects/${PID}/releases`)).flush([]);
    await fixture.whenStable();
    expect(c.tab).toBe('overview');
    expect(c.since).toBe('1h');
    expect(c.openTraceId).toBe('');
  });

  it('APM tab loads services, service map and endpoints for the project', async () => {
    const { fixture, http } = setup({ tab: 'apm', service: 'checkout' });
    await boot(fixture, http, true);
    (await next(http, `${BASE}/services`)).flush({ services: [{ name: 'checkout', requestRate: 1, errorRate: 0, p95Ms: 12 }] });
    (await next(http, `${BASE}/service-graph`)).flush({ nodes: [{ id: 'checkout', external: false, virtual: false }], edges: [] });
    const endpoints = await next(http, `${BASE}/endpoints`);
    expect(endpoints.request.params.get('service')).toBe('checkout');
    endpoints.flush({ endpoints: [{ service: 'checkout', name: 'POST /pay', requestRate: 1, errorRate: 0, p95Ms: 12 }] });
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-obs-service-map')).not.toBeNull();
    expect(el.textContent).toContain('POST /pay');
  });

  it('labels Apdex with the threshold the API uses (512 ms)', async () => {
    const { fixture, http } = setup({ tab: 'overview' });
    await boot(fixture, http, true);
    (await next(http, `${BASE}/summary`)).flush({ ...EMPTY_SUMMARY, red: { requestRate: 1, errorRate: 0, p95Ms: 10, apdex: 0.9, apdexThresholdMs: 512 } });
    (await next(http, `${BASE}/red`)).flush({});
    (await next(http, `/api/projects/${PID}/releases`)).flush([]);
    await fixture.whenStable();
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('T = 512 ms');
    expect(text).not.toContain('0.5 s');
  });

  it('profiles: service list uses the same range as the flame graph', async () => {
    const { fixture, http } = setup({ tab: 'profiles', since: '15m' });
    await boot(fixture, http, true);
    const meta = await next(http, `${BASE}/profiles/meta`);
    expect(meta.request.params.get('since')).toBe('15m');
    meta.flush({ range: { start: 0, end: 900, clamped: false }, services: ['api'], profileTypes: ['cpu'] });
    const flame = await next(http, `${BASE}/query/pyroscope`);
    expect(flame.request.params.get('since')).toBe('15m');
    flame.flush({ range: { start: 0, end: 900, clamped: false }, flamebearer: null, metadata: null });
    await fixture.whenStable();
  });

  it('shows a notice when the API shortened the range', async () => {
    const { fixture, c, http } = setup({ tab: 'profiles', since: '7d' });
    await boot(fixture, http, true);
    (await next(http, `${BASE}/profiles/meta`)).flush({ range: { start: 0, end: 86_340, clamped: true }, services: ['api'], profileTypes: ['cpu'] });
    (await next(http, `${BASE}/query/pyroscope`)).flush({ range: { start: 0, end: 86_340, clamped: true }, flamebearer: null, metadata: null });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(c.rangeNote).toBe('Range shortened to 23 h 59 min');
    expect(fixture.nativeElement.textContent).toContain('Range shortened to 23 h 59 min');
  });
});

describe('webVitalQuery (#48)', () => {
  it('never names the project (the API scopes the query)', () => {
    const q = webVitalQuery('lcp', 3600);
    expect(q).toContain('unwrap lcp');
    expect(q).toContain('[3600s]');
    expect(q).not.toContain('platform_project_id');
  });
});
