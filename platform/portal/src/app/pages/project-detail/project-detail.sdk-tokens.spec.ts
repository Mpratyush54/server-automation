import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { ProjectDetailComponent } from './project-detail.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

/** SDK token form visibility mirrors the API: create = admin/devops/tech_lead, revoke = admin/devops. */
describe('Project detail SDK tokens tab', () => {
  function create(role: string) {
    TestBed.configureTestingModule({
      imports: [ProjectDetailComponent],
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ tab: 'sdk-tokens' }), paramMap: convertToParamMap({ id: 'p1' }) } } },
        { provide: Router, useValue: jasmine.createSpyObj('Router', ['navigate']) },
        { provide: ApiService, useValue: {} },
        { provide: AuthService, useValue: { getRole: () => role, canManageUsers: () => false } },
      ],
    });
    const fixture = TestBed.createComponent(ProjectDetailComponent);
    spyOn(fixture.componentInstance, 'fetchData').and.resolveTo();
    return fixture;
  }

  async function render(role: string) {
    const fixture = create(role);
    await fixture.componentInstance.ngOnInit();
    fixture.componentInstance.activeTab = 'sdk-tokens';
    fixture.componentInstance.tokens = [];
    fixture.detectChanges();
    return fixture;
  }

  const cases: [string, boolean, boolean][] = [
    ['admin', true, true],
    ['devops', true, true],
    ['tech_lead', true, false],
    ['developer', false, false],
  ];
  for (const [role, canCreate, canRevoke] of cases) {
    it(`${role}: generate form ${canCreate ? 'shown' : 'hidden'}, revoke ${canRevoke ? 'allowed' : 'hidden'}`, async () => {
      const fixture = await render(role);
      const c = fixture.componentInstance;
      expect(c.canCreateSdkTokens).toBe(canCreate);
      expect(c.canRevokeSdkTokens).toBe(canRevoke);
      const el = fixture.nativeElement as HTMLElement;
      expect(el.textContent?.includes('Generate SDK Token')).toBe(canCreate);
      // Without the form the token table spans the full width.
      expect(el.querySelector('[data-testid="sdk-tokens-layout"]')?.classList.contains('grid-2')).toBe(canCreate);
      c.ngOnDestroy();
      fixture.destroy();
    });
  }
});
