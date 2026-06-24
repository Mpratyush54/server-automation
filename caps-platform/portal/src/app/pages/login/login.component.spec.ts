import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { LoginComponent } from './login.component';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('LoginComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;
  let router: jasmine.SpyObj<Router>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['login', 'getToken']);
    const routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: authSpy },
        { provide: Router, useValue: routerSpy },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    router = TestBed.inject(Router) as jasmine.SpyObj<Router>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(LoginComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should redirect to dashboard if already authenticated', () => {
    authService.getToken.and.returnValue('existing-token');

    TestBed.createComponent(LoginComponent);

    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('should login with email', async () => {
    authService.getToken.and.returnValue(null);
    authService.login.and.returnValue(of({ token: 'new-token' }));

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';

    await fixture.componentInstance.login();

    expect(authService.login).toHaveBeenCalledWith('test@test.com');
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('should show error when email is empty', async () => {
    authService.getToken.and.returnValue(null);

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = '';

    await fixture.componentInstance.login();

    expect(fixture.componentInstance.errorMessage).toBe('Please enter an email address.');
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('should handle login failure', async () => {
    authService.getToken.and.returnValue(null);
    authService.login.and.returnValue(throwError({ error: { error: 'Invalid credentials' } }));

    const fixture = TestBed.createComponent(LoginComponent);
    fixture.componentInstance.email = 'test@test.com';

    await fixture.componentInstance.login();

    expect(fixture.componentInstance.errorMessage).toBe('Invalid credentials');
  });

  it('should login with demo account', async () => {
    authService.getToken.and.returnValue(null);
    authService.login.and.returnValue(of({ token: 'demo-token' }));

    const fixture = TestBed.createComponent(LoginComponent);
    await fixture.componentInstance.login('john@caps.io');

    expect(authService.login).toHaveBeenCalledWith('john@caps.io');
  });

  it('should have demo accounts', () => {
    const fixture = TestBed.createComponent(LoginComponent);
    expect(fixture.componentInstance.demoAccounts.length).toBe(3);
    expect(fixture.componentInstance.demoAccounts[0].email).toBe('john@caps.io');
  });
});
