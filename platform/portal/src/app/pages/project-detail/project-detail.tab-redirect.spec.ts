import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

describe('Project detail ?tab= deep links (#29, #185)', () => {
  let router: jasmine.SpyObj<Router>;

  function create(tab: string | null) {
    router = jasmine.createSpyObj('Router', ['navigate']);
    TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(tab ? { tab } : {}), paramMap: convertToParamMap({ id: 'p1' }) } } },
        { provide: Router, useValue: router },
        { provide: ApiService, useValue: {} },
        { provide: AuthService, useValue: { getRole: () => 'devops' } },
      ],
    });
    const c = TestBed.createComponent(ProjectDetailComponent).componentInstance;
    spyOn(c, 'fetchData').and.resolveTo();
    return c;
  }

  it('no ?tab= opens the overview without rewriting the URL', async () => {
    const c = create(null);
    await c.ngOnInit();
    c.ngOnDestroy();
    expect(c.section).toBe('overview');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  const legacy: [string, string][] = [
    ['config', 'configuration'],
    ['secrets', 'configuration'],
    ['environment', 'configuration'],
    ['gitops', 'deployments'],
    ['environments', 'deployments'],
    ['databases', 'data'],
    ['sdk-tokens', 'settings'],
    ['nonsense', 'overview'],
  ];
  for (const [tab, section] of legacy) {
    it(`?tab=${tab} opens ${section} and rewrites the URL to ?tab=${section}`, async () => {
      const c = create(tab);
      await c.ngOnInit();
      c.ngOnDestroy();
      expect(c.section).toBe(section as any);
      expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { tab: section }, replaceUrl: true }));
    });
  }

  const legacyMonitoring: [string, string][] = [['logs', 'logs'], ['api-metrics', 'traces'], ['metrics', 'resources']];
  for (const [tab, view] of legacyMonitoring) {
    it(`?tab=${tab} opens the ${view} monitoring view and rewrites the URL`, async () => {
      const c = create(tab);
      await c.ngOnInit();
      c.ngOnDestroy();
      expect(c.section).toBe('monitoring');
      expect(c.monitoringView).toBe(view as any);
      expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { tab: 'monitoring', view }, replaceUrl: true }));
    });
  }

  it('a current section id opens that section without a redirect', async () => {
    const c = create('monitoring');
    await c.ngOnInit();
    c.ngOnDestroy();
    expect(c.section).toBe('monitoring');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('switching sections keeps the section in ?tab=', async () => {
    const c = create(null);
    await c.ngOnInit();
    c.ngOnDestroy();
    c.switchSection('settings');
    expect(c.section).toBe('settings');
    expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { tab: 'settings' }, replaceUrl: true }));
  });
});
