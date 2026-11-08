import { TestBed } from '@angular/core/testing';
import { Router, ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { OauthAuthorizeComponent } from './oauth-authorize.component';
import { AuthService } from '../../services/auth.service';

describe('OauthAuthorizeComponent', () => {
  let router: jasmine.SpyObj<Router>;
  let auth: jasmine.SpyObj<AuthService>;
  let http: HttpTestingController;
  let route: any;

  const REDIRECT = 'https://platform.example.test/argocd/auth/callback';

  beforeEach(async () => {
    const routerSpy = jasmine.createSpyObj('Router', ['navigate', 'createUrlTree', 'serializeUrl']);
    const authSpy = jasmine.createSpyObj('AuthService', ['isAuthenticated']);

    route = {
      snapshot: {
        queryParams: {
          client_id: 'argocd',
          redirect_uri: REDIRECT,
          response_type: 'code',
          state: 'state123',
          token: 'should-never-be-forwarded',
        },
      },
    };

    await TestBed.configureTestingModule({
      imports: [OauthAuthorizeComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Router, useValue: routerSpy },
        { provide: ActivatedRoute, useValue: route },
        { provide: AuthService, useValue: authSpy },
      ],
    }).compileComponents();

    router = TestBed.inject(Router) as jasmine.SpyObj<Router>;
    auth = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('should create', () => {
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should redirect to login if not signed in', async () => {
    auth.isAuthenticated.and.returnValue(false);
    router.createUrlTree.and.returnValue({} as any);
    router.serializeUrl.and.returnValue('/oauth/authorize?client_id=argocd');

    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    await fixture.componentInstance.ngOnInit();

    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/oauth/authorize?client_id=argocd' }
    });
  });

  it('shows a consent screen and only POSTs (no token in URL) after Allow', async () => {
    auth.isAuthenticated.and.returnValue(true);
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    const cmp = fixture.componentInstance;
    const nav = spyOn(cmp, 'navigateExternal');

    const init = cmp.ngOnInit();
    const clientReq = http.expectOne((r) => r.url === '/api/oauth/clients/argocd');
    expect(clientReq.request.params.get('redirect_uri')).toBe(REDIRECT);
    clientReq.flush({ client_id: 'argocd', name: 'Argo CD', redirect_uri_valid: true });
    await init;

    expect(cmp.status).toBe('consent');
    expect(cmp.clientName).toBe('Argo CD');
    expect(nav).not.toHaveBeenCalled();

    const allow = cmp.allow();
    const post = http.expectOne('/api/oauth/authorize');
    expect(post.request.method).toBe('POST');
    expect(post.request.urlWithParams).not.toContain('token');
    expect(post.request.body.token).toBeUndefined();
    expect(post.request.body.client_id).toBe('argocd');
    post.flush({ redirect: `${REDIRECT}?code=abc&state=state123` });
    await allow;

    expect(nav).toHaveBeenCalledWith(`${REDIRECT}?code=abc&state=state123`);
  });

  it('refuses an unregistered redirect_uri without navigating', async () => {
    auth.isAuthenticated.and.returnValue(true);
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    const cmp = fixture.componentInstance;
    const nav = spyOn(cmp, 'navigateExternal');

    const init = cmp.ngOnInit();
    http.expectOne((r) => r.url === '/api/oauth/clients/argocd').flush({ client_id: 'argocd', name: 'Argo CD', redirect_uri_valid: false });
    await init;

    expect(cmp.status).toBe('error');
    expect(nav).not.toHaveBeenCalled();
    http.expectNone('/api/oauth/authorize');
  });

  it('returns access_denied to the client on Cancel', async () => {
    auth.isAuthenticated.and.returnValue(true);
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    const cmp = fixture.componentInstance;
    const nav = spyOn(cmp, 'navigateExternal');
    const init = cmp.ngOnInit();
    http.expectOne((r) => r.url === '/api/oauth/clients/argocd').flush({ client_id: 'argocd', name: 'Argo CD', redirect_uri_valid: true });
    await init;

    cmp.deny();
    expect(nav).toHaveBeenCalledWith(`${REDIRECT}?error=access_denied&state=state123`);
  });
});
