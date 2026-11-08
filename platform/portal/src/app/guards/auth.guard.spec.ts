import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';

describe('authGuard', () => {
  let auth: jasmine.SpyObj<AuthService> & { profileVerified: boolean };
  let router: Router;
  const original = window.location.pathname + window.location.search;

  function setUrl(url: string) {
    window.history.replaceState(null, '', url);
  }

  async function run(url: string) {
    setUrl(url);
    return TestBed.runInInjectionContext(() => authGuard({} as any, { url } as any)) as Promise<boolean | UrlTree>;
  }

  beforeEach(() => {
    localStorage.clear();
    auth = Object.assign(
      jasmine.createSpyObj('AuthService', ['isAuthenticated', 'exchangeLoginCode', 'loadProfile', 'clearSession', 'decodeToken']),
      { profileVerified: false },
    );
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    setUrl(original);
    localStorage.clear();
  });

  it('never stores a token from the URL (forged or not)', async () => {
    auth.isAuthenticated.and.returnValue(false);
    const forged = `h.${btoa(JSON.stringify({ id: 'x', role: 'devops', exp: 9999999999 }))}.sig`;
    const result = await run(`/dashboard?token=${forged}`);
    expect(localStorage.getItem('plat_auth_token')).toBeNull();
    expect(localStorage.getItem('plat_user_profile')).toBeNull();
    expect(window.location.search).not.toContain('token');
    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('exchanges ?code= over the API and strips it from the address bar', async () => {
    auth.exchangeLoginCode.and.resolveTo(true);
    const result = await run('/dashboard?code=abc123');
    expect(auth.exchangeLoginCode).toHaveBeenCalledWith('abc123');
    expect(window.location.search).not.toContain('code');
    expect(router.serializeUrl(result as UrlTree)).toBe('/dashboard');
  });

  it('sends the user to login when the code exchange fails', async () => {
    auth.exchangeLoginCode.and.resolveTo(false);
    const result = await run('/dashboard?code=stale');
    expect(router.serializeUrl(result as UrlTree)).toMatch(/^\/login\?error=/);
  });

  it('loads the profile (role) from the API before activating', async () => {
    auth.isAuthenticated.and.returnValue(true);
    auth.loadProfile.and.resolveTo(true);
    const result = await run('/dashboard');
    expect(auth.loadProfile).toHaveBeenCalled();
    expect(result).toBeTrue();
  });
});
