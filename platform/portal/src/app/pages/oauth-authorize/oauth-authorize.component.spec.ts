import { TestBed } from '@angular/core/testing';
import { Router, ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { OauthAuthorizeComponent } from './oauth-authorize.component';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';

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
  it('shows a rejected assistant request from the API on our own page without calling anything', async () => {
    route.snapshot.queryParams = { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' };
    auth.isAuthenticated.and.returnValue(false);
    const fixture = TestBed.createComponent(OauthAuthorizeComponent);
    const cmp = fixture.componentInstance;
    const nav = spyOn(cmp, 'navigateExternal');
    await cmp.ngOnInit();
    expect(cmp.status).toBe('error');
    expect(cmp.errorMessage).toContain('PKCE');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
    http.expectNone(() => true);
  });

  describe('AI assistant (remote MCP client)', () => {
    const MCP_ID = 'mcp_0123456789abcdef0123456789abcdef';
    const MCP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
    const RESOURCE = 'https://cairn.example.test/mcp';
    const SCOPES = [
      { id: 'projects:read', label: 'See your projects', description: 'd', readOnly: true, allowed: true, requested: true, checked: true },
      { id: 'logs:read', label: 'Read logs', description: 'd', readOnly: true, allowed: true, requested: true, checked: true },
      { id: 'commands:execute', label: 'Run allowed commands', description: 'd', readOnly: false, allowed: false, requested: true, checked: false },
    ];

    beforeEach(() => {
      route.snapshot.queryParams = {
        client_id: MCP_ID,
        redirect_uri: MCP_REDIRECT,
        response_type: 'code',
        state: 'st',
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        scope: 'projects:read logs:read commands:execute',
      };
      auth.isAuthenticated.and.returnValue(true);
    });

    async function open() {
      const fixture = TestBed.createComponent(OauthAuthorizeComponent);
      const cmp = fixture.componentInstance;
      const nav = spyOn(cmp, 'navigateExternal');
      fixture.detectChanges(); // runs ngOnInit
      http.expectOne((r) => r.url === `/api/oauth/clients/${MCP_ID}`).flush({ client_id: MCP_ID, name: 'Claude', kind: 'mcp', redirect_uri_valid: true });
      await new Promise((r) => setTimeout(r));
      const consent = http.expectOne((r) => r.url === '/api/oauth/consent');
      expect(consent.request.params.get('resource')).toBe(RESOURCE);
      expect(consent.request.params.get('code_challenge')).toBe('c'.repeat(43));
      consent.flush({ name: 'Claude', kind: 'mcp', redirect_host: 'https://claude.ai', scopes: SCOPES.map((s) => ({ ...s })) });
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
      expect(cmp.status).toBe('consent');
      fixture.detectChanges();
      return { fixture, cmp, nav };
    }

    it('shows the assistant name, redirect host and permission checkboxes', async () => {
      const { fixture, cmp } = await open();
      expect(cmp.kind).toBe('mcp');
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="client-name"]')?.textContent).toContain('Claude');
      expect(el.querySelector('[data-testid="redirect-host"]')?.textContent).toContain('https://claude.ai');
      const exec = el.querySelector('[data-testid="scope-commands:execute"]') as HTMLInputElement;
      expect(exec.disabled).toBeTrue();
      expect((el.querySelector('[data-testid="scope-projects:read"]') as HTMLInputElement).checked).toBeTrue();
      expect(el.textContent).toContain('Your role cannot grant this.');
    });

    it('posts only the ticked, allowed scopes and follows the redirect', async () => {
      const { cmp, nav } = await open();
      cmp.toggle(cmp.scopes[1], false);
      cmp.toggle(cmp.scopes[2], true); // not allowed: ignored
      const allow = cmp.allow();
      const post = http.expectOne('/api/oauth/authorize');
      expect(post.request.body.scopes).toEqual(['projects:read']);
      expect(post.request.body.resource).toBe(RESOURCE);
      expect(post.request.body.client_id).toBe(MCP_ID);
      post.flush({ redirect: `${MCP_REDIRECT}?code=abc&state=st` });
      await allow;
      expect(nav).toHaveBeenCalledWith(`${MCP_REDIRECT}?code=abc&state=st`);
    });

    it('asks for a two-factor code when the API requires step-up, then retries', async () => {
      const stepUp = TestBed.inject(StepUpService);
      spyOn(stepUp, 'request').and.returnValue(Promise.resolve(true));
      const { cmp, nav } = await open();
      const allow = cmp.allow();
      http.expectOne('/api/oauth/authorize').flush({ error: 'step_up_required' }, { status: 401, statusText: 'Unauthorized' });
      await new Promise((r) => setTimeout(r));
      expect(stepUp.request).toHaveBeenCalled();
      http.expectOne('/api/oauth/authorize').flush({ redirect: `${MCP_REDIRECT}?code=xyz&state=st` });
      await allow;
      expect(nav).toHaveBeenCalledWith(`${MCP_REDIRECT}?code=xyz&state=st`);
    });

    it('keeps the screen open with a message when step-up is cancelled', async () => {
      const stepUp = TestBed.inject(StepUpService);
      spyOn(stepUp, 'request').and.returnValue(Promise.resolve(false));
      const { cmp, nav } = await open();
      const allow = cmp.allow();
      http.expectOne('/api/oauth/authorize').flush({ error: 'step_up_required' }, { status: 401, statusText: 'Unauthorized' });
      await allow;
      expect(nav).not.toHaveBeenCalled();
      expect(cmp.status).toBe('consent');
      expect(cmp.formError).toContain('authenticator');
    });

    it('refuses to approve with no permission ticked', async () => {
      const { cmp } = await open();
      cmp.scopes.forEach((s) => cmp.toggle(s, false));
      await cmp.allow();
      http.expectNone('/api/oauth/authorize');
      expect(cmp.formError).toContain('at least one');
    });
  });
});
