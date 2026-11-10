import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

describe('Project detail ?tab= deep links (#29)', () => {
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

  for (const legacy of ['config', 'secrets']) {
    it(`?tab=${legacy} redirects to ?tab=environment`, async () => {
      const c = create(legacy);
      await c.ngOnInit();
      c.ngOnDestroy();
      expect(c.activeTab).toBe('environment');
      expect(router.navigate).toHaveBeenCalledWith([], jasmine.objectContaining({ queryParams: { tab: 'environment' }, replaceUrl: true }));
    });
  }

  it('other ?tab= values open that tab without redirect', async () => {
    const c = create('logs');
    await c.ngOnInit();
    c.ngOnDestroy();
    expect(c.activeTab).toBe('logs');
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
