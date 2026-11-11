import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { ObsFleetComponent } from './obs-fleet.component';

const row = (id: string, name: string, health: string, extra: any = {}) => ({
  projectId: id, name, health, requestRate: 2, errorRate: 0.5, p95Ms: 120, activeAlerts: 0, criticalAlerts: 0, openErrors: 1, synthetics: 'operational', slos: { total: 0, breaching: 0 }, ...extra,
});

async function next(http: HttpTestingController, url: string) {
  for (let i = 0; i < 50; i++) {
    const m = http.match((r) => r.url === url);
    if (m.length) return m[0];
    await new Promise((r) => setTimeout(r));
  }
  throw new Error(`no request to ${url}`);
}

describe('ObsFleetComponent (#48)', () => {
  function setup(since: string | null = null) {
    TestBed.configureTestingModule({
      imports: [ObsFleetComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(since ? { since } : {}) } } },
      ],
    });
    const fixture = TestBed.createComponent(ObsFleetComponent);
    return { fixture, http: TestBed.inject(HttpTestingController) };
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('loads the fleet for the time range in the URL and lists projects worst first', async () => {
    const { fixture, http } = setup('6h');
    fixture.detectChanges();
    const req = await next(http, '/api/observability/fleet');
    expect(req.request.params.get('since')).toBe('6h');
    req.flush({ telemetryEnabled: true, scope: 'all', projects: [row('a', 'alpha', 'healthy'), row('b', 'bravo', 'critical', { errorRate: 9, activeAlerts: 2, criticalAlerts: 1 }), row('c', 'charlie', 'degraded')] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const names = Array.from(el.querySelectorAll('tbody tr')).map((tr) => tr.getAttribute('data-project'));
    expect(names).toEqual(['b', 'c', 'a']);
    expect(el.textContent).toContain('all projects');
    expect(el.textContent).toContain('9.00%');
    expect(el.querySelector('[data-testid="telemetry-disabled"]')).toBeNull();
  });

  it('shows the telemetry-disabled empty state but still lists alerts and errors', async () => {
    const { fixture, http } = setup();
    fixture.detectChanges();
    (await next(http, '/api/observability/fleet')).flush({ telemetryEnabled: false, scope: 'member', projects: [row('a', 'alpha', 'unknown', { requestRate: null, errorRate: null, p95Ms: null, openErrors: 4 })] });
    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="telemetry-disabled"]')).not.toBeNull();
    expect(el.textContent).toContain('your projects');
    expect(el.textContent).toContain('No data');
  });

  it('changing the time range updates the URL and reloads', async () => {
    const { fixture, http } = setup();
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture.detectChanges();
    (await next(http, '/api/observability/fleet')).flush({ projects: [] });
    await fixture.whenStable();
    fixture.componentInstance.since = '24h';
    fixture.componentInstance.onSince();
    expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { since: '24h' } }));
    expect(http.expectOne((r) => r.url === '/api/observability/fleet').request.params.get('since')).toBe('24h');
  });
});
