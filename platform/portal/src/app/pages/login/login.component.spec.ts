import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { LoginComponent } from './login.component';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('LoginComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;
  let router: jasmine.SpyObj<Router>;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['login', 'getToken', 'isAuthenticated']);
    const routerSpy = jasmine.createSpyObj('Router', ['navigate', 'navigateByUrl']);
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
        { provide: Router, useValue: routerSpy },
        { provide: ApiService, useValue: apiSpy },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    router = TestBed.inject(Router) as jasmine.SpyObj<Router>;
    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(LoginComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should redirect to dashboard if already authenticated', () => {
    authService.isAuthenticated.and.returnValue(true);

    TestBed.createComponent(LoginComponent);

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
});
