import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { MonitoringView } from '../observability/monitoring-views';

/** Monitoring section: every view renders in place on the project page (?tab=monitoring&view=…). */
describe('Project detail monitoring views', () => {
  let router: Router;

  async function render(view: MonitoringView, observability: boolean, query: Record<string, string> = {}) {
    if (!jasmine.isSpy(window.alert)) spyOn(window, 'alert');
    TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({ tab: 'monitoring', view, ...query }), paramMap: convertToParamMap({ id: 'p1' }) } },
        },
        { provide: ApiService, useValue: { getObservabilityStatus: () => of({ enabled: observability }) } },
        { provide: AuthService, useValue: { getRole: () => 'devops', canManageUsers: () => false, isTechLeadOrDevOps: () => true, isDevOps: () => true, isAdmin: () => false, getUser: () => null } },
      ],
    });
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    const fixture = TestBed.createComponent(ProjectDetailComponent);
    const c = fixture.componentInstance;
    spyOn(c, 'fetchData').and.resolveTo();
    spyOn(c, 'loadMonitoringData').and.resolveTo([]);
    await c.ngOnInit();
    c.ngOnDestroy();
    c.project = { id: 'p1', name: 'shop', isActive: true, environments: [] };
    fixture.detectChanges();
    // Embedded views sit in @defer blocks (lazy chunks); render them without waiting on their HTTP calls.
    for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
    fixture.detectChanges();
    return fixture;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('reads the view from ?view= and marks it active', async () => {
    const fixture = await render('uptime', true);
    const el: HTMLElement = fixture.nativeElement;
    expect(fixture.componentInstance.section).toBe('monitoring');
    expect(el.querySelector('[data-testid="monitoring-views"] .active')!.textContent!.trim()).toBe('Uptime');
    expect(el.querySelector('app-synthetics')).toBeTruthy();
    expect(el.querySelector('app-status-page-editor')).toBeTruthy();
    expect(el.querySelector('[data-testid="observability-redirect"]')).toBeNull();
    fixture.destroy();
  });

  it('overview embeds the health summary and recent errors', async () => {
    const fixture = await render('overview', true);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('app-obs-project')).toBeTruthy();
    expect(el.querySelector('app-errors')).toBeTruthy();
    expect(el.querySelector('[data-testid="needs-full-profile"]')).toBeNull();
    fixture.destroy();
  });

  it('traces with full telemetry embeds APM and trace search, without a page header', async () => {
    const fixture = await render('traces', true);
    const el: HTMLElement = fixture.nativeElement;
    const obs = el.querySelector('app-obs-project')!;
    expect(obs).toBeTruthy();
    expect(obs.querySelector('h1')).toBeNull();
    expect(obs.querySelector('nav.subnav')).toBeNull();
    expect(el.querySelector('#api-latency')).toBeNull();
    fixture.destroy();
  });

  it('without full telemetry, logs show a one-line notice and the SDK log stream', async () => {
    const fixture = await render('logs', false);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="needs-full-profile"]')!.textContent).toContain('full install profile');
    expect(el.querySelector('#logs')).toBeTruthy();
    expect(el.querySelector('app-obs-project')).toBeNull();
    fixture.destroy();
  });

  it('without full telemetry, resources still show SDK heartbeats', async () => {
    const fixture = await render('resources', false);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('#metrics')).toBeTruthy();
    expect(el.querySelector('[data-testid="needs-full-profile"]')).toBeTruthy();
    fixture.destroy();
  });

  it('users embeds replays and heatmaps; AI agents embeds the agents panel', async () => {
    let fixture = await render('users', true);
    expect(fixture.nativeElement.querySelector('app-replays')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-heatmaps')).toBeTruthy();
    fixture.destroy();
    TestBed.resetTestingModule();
    fixture = await render('agents', true);
    expect(fixture.nativeElement.querySelector('app-project-agents')).toBeTruthy();
    fixture.destroy();
  });

  it('the view switcher writes ?view= and clears view-specific params, never ?tab=', async () => {
    const fixture = await render('overview', true);
    const el: HTMLElement = fixture.nativeElement;
    (el.querySelector('[data-testid="monitoring-views"] [data-view="errors"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.monitoringView).toBe('errors');
    const call = (router.navigate as jasmine.Spy).calls.mostRecent().args[1];
    expect(call.queryParams.view).toBe('errors');
    expect(call.queryParams.trace).toBeNull();
    expect('tab' in call.queryParams).toBeFalse();
    fixture.destroy();
  });

  it('opening an issue from the overview lands on the Errors view with that issue', async () => {
    const fixture = await render('overview', true);
    const c = fixture.componentInstance;
    c.openErrorIssue('e1');
    expect(c.monitoringView).toBe('errors');
    expect(c.monitoringIssue).toBe('e1');
    expect((router.navigate as jasmine.Spy).calls.mostRecent().args[1].queryParams).toEqual(jasmine.objectContaining({ view: 'errors', issue: 'e1' }));
    fixture.destroy();
  });

  it('leaving Monitoring drops ?view=', async () => {
    const fixture = await render('logs', true);
    fixture.componentInstance.switchSection('settings');
    const qp = (router.navigate as jasmine.Spy).calls.mostRecent().args[1].queryParams;
    expect(qp.tab).toBe('settings');
    expect(qp.view).toBeNull();
    fixture.destroy();
  });
});
