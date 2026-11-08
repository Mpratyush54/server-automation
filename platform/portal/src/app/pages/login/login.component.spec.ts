import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, ActivatedRoute } from '@angular/router';
import { LoginComponent } from './login.component';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('LoginComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;
  let router: Router;
  let queryParams: Record<string, string>;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['login', 'getToken', 'isAuthenticated']);
    queryParams = {};
    const apiSpy = jasmine.createSpyObj('ApiService', ['getAuthProviders']);
    apiSpy.getAuthProviders.and.returnValue(of({
      github: { enabled: false, configured: false },
      gitlab: { enabled: true, configured: true, url: 'https://gitlab.com' },
    }));

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: authSpy },
        { provide: ActivatedRoute, useValue: { snapshot: { get queryParams() { return queryParams; } } } },
        { provide: ApiService, useValue: apiSpy },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    // Real router (the template uses routerLink); spy on navigation only.
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    spyOn(router, 'navigateByUrl').and.resolveTo(true);
    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(LoginComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should redirect to dashboard if already authenticated', async () => {
    authService.isAuthenticated.and.returnValue(true);

    await TestBed.createComponent(LoginComponent).componentInstance.ngOnInit();

    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('should load GitHub and GitLab provider flags', async () => {
    authService.isAuthenticated.and.returnValue(false);
    const fixture = TestBed.createComponent(LoginComponent);
    await fixture.componentInstance.ngOnInit();
    expect(apiService.getAuthProviders).toHaveBeenCalled();
    expect(fixture.componentInstance.providers.gitlab.enabled).toBeTrue();
    expect(fixture.componentInstance.providers.github.enabled).toBeFalse();
  });

  it('should login with email and password', async () => {
    authService.isAuthenticated.and.returnValue(false);
    authService.login.and.returnValue(of({ token: 'new-token' }));

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';
    fixture.componentInstance.password = 'TestPass123';

    await fixture.componentInstance.login();

    expect(authService.login).toHaveBeenCalledWith('test@test.com', 'TestPass123');
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('should login with username when identity has no @', async () => {
    authService.isAuthenticated.and.returnValue(false);
    authService.login.and.returnValue(of({ token: 'new-token' }));

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'devops';
    fixture.componentInstance.password = 'TestPass123';

    await fixture.componentInstance.login();

    expect(authService.login).toHaveBeenCalledWith('', 'TestPass123', 'devops');
  });

  it('should show error when email is empty', async () => {
    authService.isAuthenticated.and.returnValue(false);

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = '';
    fixture.componentInstance.password = 'x';

    await fixture.componentInstance.login();

    expect(fixture.componentInstance.errorMessage).toBe('Please enter your email or username.');
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('should handle login failure', async () => {
    authService.isAuthenticated.and.returnValue(false);
    authService.login.and.returnValue(throwError(() => ({ error: { error: 'Invalid credentials' } })));

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';
    fixture.componentInstance.password = 'wrong';

    await fixture.componentInstance.login();

    expect(fixture.componentInstance.errorMessage).toBe('Invalid credentials');
  });

  it('should follow a same-origin returnUrl after login (SSO consent flow)', async () => {
    authService.isAuthenticated.and.returnValue(false);
    authService.login.and.returnValue(of({ token: 'new-token' }));
    queryParams = { returnUrl: '/oauth/authorize?client_id=argocd' };

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';
    fixture.componentInstance.password = 'TestPass123';
    await fixture.componentInstance.login();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/oauth/authorize?client_id=argocd');
  });

  it('should ignore an off-site returnUrl (open redirect)', async () => {
    authService.isAuthenticated.and.returnValue(false);
    authService.login.and.returnValue(of({ token: 'new-token' }));
    queryParams = { returnUrl: '//evil.example/phish' };

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';
    fixture.componentInstance.password = 'TestPass123';
    await fixture.componentInstance.login();

    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });
});
