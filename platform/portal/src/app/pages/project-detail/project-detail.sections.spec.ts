import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

/** Page shell (#185): header, section navigation, role-gated actions in the new sections. */
describe('Project detail sections (#185)', () => {
  let api: any;

  function create(role: string) {
    api = {
      createProjectToken: jasmine.createSpy('createProjectToken').and.returnValue(of({ token: 'plat_sdk_secret', kind: 'browser' })),
      getProjectTokens: jasmine.createSpy('getProjectTokens').and.returnValue(of([])),
      getProjectPrivacy: jasmine.createSpy('getProjectPrivacy').and.returnValue(of({ builtinScrubRules: [], scrubRules: [] })),
    };
    TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}), paramMap: convertToParamMap({ id: 'p1' }) } } },
        { provide: Router, useValue: jasmine.createSpyObj('Router', ['navigate']) },
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { getRole: () => role, canManageUsers: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(ProjectDetailComponent);
    spyOn(fixture.componentInstance, 'fetchData').and.resolveTo();
    return fixture;
  }

  async function render(role: string, setup: (c: ProjectDetailComponent) => void = () => {}) {
    const fixture = create(role);
    const c = fixture.componentInstance;
    await c.ngOnInit();
    c.ngOnDestroy();
    // `id` is omitted so child panels that fetch on their own (privacy, releases) stay idle.
    c.project = { name: 'shop', isActive: true, stack: 'nodejs', domain: 'shop.example.com', repositoryUrl: 'https://github.com/acme/shop.git', environments: [] };
    setup(c);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the header with a truthful status, Deploy and Open app, and six sections', async () => {
    const fixture = await render('devops');
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('h1.page-title')!.textContent).toContain('shop');
    const status = el.querySelector('[data-testid="project-status"]')!;
    expect(status.textContent!.trim()).toBe('Active');
    expect(status.classList).toContain('status-ok');
    expect(el.textContent).toContain('acme/shop');
    const primary = el.querySelectorAll('.btn-primary');
    expect(primary.length).toBe(1);
    expect(primary[0].textContent!.trim()).toBe('Deploy');
    const open = Array.from(el.querySelectorAll('a.btn')).find((a) => a.textContent!.includes('Open app'))!;
    expect(open.getAttribute('href')).toBe('https://shop.example.com');
    const nav = Array.from(el.querySelectorAll('nav.subnav button')).map((b) => b.textContent!.trim());
    expect(nav).toEqual(['Overview', 'Deployments', 'Configuration', 'Data', 'Monitoring', 'Settings']);
    expect(el.querySelector('nav.subnav .active')!.textContent!.trim()).toBe('Overview');
    expect(el.querySelector('app-project-overview')).toBeTruthy();
    fixture.destroy();
  });

  it('shows Being deleted, with a way to the progress, for projects the API marks inactive', async () => {
    const fixture = await render('devops', (c) => (c.project.isActive = false));
    expect(fixture.nativeElement.querySelector('[data-testid="project-status"]').textContent.trim()).toBe('Being deleted');
    (fixture.nativeElement.querySelector('[data-testid="project-deleting-progress"]') as HTMLButtonElement).click();
    expect(fixture.componentInstance.deleteDialogProject).toEqual({ id: fixture.componentInstance.project.id, name: fixture.componentInstance.project.name });
    fixture.destroy();
  });

  it('header Deploy opens the Deployments section with the deploy form', async () => {
    const fixture = await render('devops');
    (fixture.nativeElement.querySelector('.page-header .btn-primary') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.componentInstance.section).toBe('deployments');
    expect(fixture.nativeElement.querySelector('#deploy-form')).toBeTruthy();
    fixture.destroy();
  });

  it('deployment history keeps role-gated rollback and restart', async () => {
    const deps = [{ id: 'd1', version: 'v1', branch: 'main', commitSha: 'abc', status: 'deployed', imageTag: 'x' }];
    for (const [role, rollback, restart] of [['developer', false, false], ['tech_lead', true, false], ['devops', true, true]] as const) {
      TestBed.resetTestingModule();
      const fixture = await render(role, (c) => { c.section = 'deployments'; c.deployments = deps; });
      const labels = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).map((b) => b.textContent!.trim());
      expect(labels.includes('Rollback')).withContext(role).toBe(rollback);
      expect(labels.includes('Restart')).withContext(role).toBe(restart);
      fixture.destroy();
    }
  });

  it('Settings: access form only for managers; generating a token uses the typed name and kind', async () => {
    // tech_lead: may create SDK tokens but not manage project access.
    const fixture = await render('tech_lead', (c) => { c.section = 'settings'; c.project.id = 'p1'; });
    const el: HTMLElement = fixture.nativeElement;
    const c = fixture.componentInstance;
    expect(el.querySelector('#member-email')).toBeNull();
    const name = el.querySelector<HTMLInputElement>('#sdk-token-name')!;
    name.value = 'ci key';
    name.dispatchEvent(new Event('input'));
    const kind = el.querySelector<HTMLSelectElement>('#sdk-token-kind')!;
    kind.value = 'browser';
    kind.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(c.newKeyName).toBe('ci key');
    expect(c.newKeyKind).toBe('browser');
    const gen = Array.from(el.querySelectorAll('button')).find((b) => b.textContent!.trim() === 'Generate token')!;
    gen.click();
    await new Promise((r) => setTimeout(r));
    expect(api.createProjectToken).toHaveBeenCalledWith('p1', 'ci key', 'browser');
    fixture.detectChanges();
    expect(el.textContent).toContain('plat_sdk_secret');
    fixture.destroy();
  });

  it('Settings: managers get the grant form', async () => {
    const fixture = await render('devops', (c) => { c.section = 'settings'; });
    expect(fixture.nativeElement.querySelector('#member-email')).toBeTruthy();
    fixture.destroy();
  });

  it('Monitoring shows a view switcher in place, without the old redirect card or link panel', async () => {
    const fixture = await render('devops', (c) => { c.section = 'monitoring'; c.observabilityEnabled = true; c.observabilityChecked = true; });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="observability-redirect"]')).toBeNull();
    expect(el.textContent).not.toContain('More monitoring');
    const views = Array.from(el.querySelectorAll('[data-testid="monitoring-views"] button')).map((b) => b.textContent!.trim());
    expect(views).toEqual(['Overview', 'Errors', 'Logs', 'Traces', 'Users', 'Uptime', 'Resources', 'Usage', 'AI agents']);
    expect(el.querySelector('[data-testid="monitoring-views"] .active')!.textContent!.trim()).toBe('Overview');
    fixture.destroy();
  });
});
