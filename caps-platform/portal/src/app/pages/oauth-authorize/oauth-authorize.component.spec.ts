import { TestBed } from '@angular/core/testing';
import { Router, ActivatedRoute } from '@angular/router';
import { OauthAuthorizeComponent } from './oauth-authorize.component';

describe('OauthAuthorizeComponent', () => {
  let router: jasmine.SpyObj<Router>;
  let route: any;

  beforeEach(async () => {
    const routerSpy = jasmine.createSpyObj('Router', ['navigate', 'createUrlTree', 'serializeUrl']);
    
    route = {
      snapshot: {
        queryParams: {
          client_id: 'argocd',
          redirect_uri: 'http://localhost/callback',
          state: 'state123'
        }
      }
    };

    await TestBed.configureTestingModule({
      imports: [OauthAuthorizeComponent],
      providers: [
        { provide: Router, useValue: routerSpy },
        { provide: ActivatedRoute, useValue: route }
      ]
    }).compileComponents();

    router = TestBed.inject(Router) as jasmine.SpyObj<Router>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should redirect to login if no token is in localStorage', () => {
    spyOn(localStorage, 'getItem').and.returnValue(null);
    router.createUrlTree.and.returnValue({} as any);
    router.serializeUrl.and.returnValue('/oauth/authorize?client_id=argocd');

    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    fixture.componentInstance.ngOnInit();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/oauth/authorize?client_id=argocd' }
    });
  });
});
