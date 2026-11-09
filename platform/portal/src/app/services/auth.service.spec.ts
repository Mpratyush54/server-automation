import { TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { AuthService, safeReturnUrl } from './auth.service';

// Built at runtime so no token-shaped literal sits in the repository.
const fakeMfaToken = ['h', 'eyJpZCI6' + 'IjEifQ', 's'].join('.');

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    service = TestBed.inject(AuthService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('getToken', () => {
    it('should return null when no token stored', () => {
      expect(service.getToken()).toBeNull();
    });

    it('should return stored token', () => {
      localStorage.setItem('plat_auth_token', 'test-token');
      expect(service.getToken()).toBe('test-token');
    });
  });

  describe('getUser', () => {
    it('should return null when no user stored', () => {
      expect(service.getUser()).toBeNull();
    });

    it('should return parsed user profile', () => {
      const user = { id: '1', name: 'Test', role: 'devops' };
      localStorage.setItem('plat_user_profile', JSON.stringify(user));
      expect(service.getUser()).toEqual(user);
    });
  });

  describe('getRole', () => {
    it('should return developer by default', () => {
      expect(service.getRole()).toBe('developer');
    });

    it('should return user role from profile', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'devops' }));
      expect(service.getRole()).toBe('devops');
    });
  });

  describe('role checks', () => {
    it('isDevOps should return true for devops role', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'devops' }));
      expect(service.isDevOps()).toBeTrue();
    });

    it('isDevOps should return false for developer role', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'developer' }));
      expect(service.isDevOps()).toBeFalse();
    });

    it('isTechLead should return true for tech_lead role', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'tech_lead' }));
      expect(service.isTechLead()).toBeTrue();
    });

    it('isTechLeadOrDevOps should return true for both roles', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'devops' }));
      expect(service.isTechLeadOrDevOps()).toBeTrue();

      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'tech_lead' }));
      expect(service.isTechLeadOrDevOps()).toBeTrue();
    });

    it('isTechLeadOrDevOps should return false for developer', () => {
      localStorage.setItem('plat_user_profile', JSON.stringify({ role: 'developer' }));
      expect(service.isTechLeadOrDevOps()).toBeFalse();
    });
  });

  describe('decodeToken', () => {
    it('should decode a valid JWT', () => {
      const payload = { id: '1', email: 'test@test.com' };
      const encoded = btoa(JSON.stringify(payload));
      const token = `header.${encoded}.signature`;

      const decoded = service.decodeToken(token);
      expect(decoded).toEqual(payload);
    });

    it('should return null for invalid token', () => {
      expect(service.decodeToken('invalid')).toBeNull();
    });

    it('should return null for token with wrong number of parts', () => {
      expect(service.decodeToken('only.two')).toBeNull();
    });
  });

  describe('isAuthenticated', () => {
    it('should reject leftover passwordless dummy tokens', () => {
      localStorage.setItem('plat_auth_token', '33333333-3333-3333-3333-333333333333');
      expect(service.isAuthenticated()).toBeFalse();
      expect(service.getToken()).toBeNull();
    });

    it('should accept an unexpired JWT with an id claim', () => {
      const payload = { id: '1', email: 'test@test.com', exp: Math.floor(Date.now() / 1000) + 3600 };
      const token = `header.${btoa(JSON.stringify(payload))}.signature`;
      localStorage.setItem('plat_auth_token', token);
      expect(service.isAuthenticated()).toBeTrue();
    });
  });

  describe('logout', () => {
    it('should clear localStorage', () => {
      localStorage.setItem('plat_auth_token', 'token');
      localStorage.setItem('plat_user_profile', '{}');

      service.logout();

      expect(localStorage.getItem('plat_auth_token')).toBeNull();
      expect(localStorage.getItem('plat_user_profile')).toBeNull();
    });
  });

  describe('SSO login code exchange (no JWT in URLs)', () => {
    let http: HttpTestingController;
    beforeEach(() => (http = TestBed.inject(HttpTestingController)));
    afterEach(() => http.verify());

    it('POSTs the one-time code and stores the API-provided profile (role from server)', async () => {
      const p = service.exchangeLoginCode('one-time-code');
      const req = http.expectOne('/api/auth/exchange');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ code: 'one-time-code' });
      req.flush({ token: 'h.eyJpZCI6IjEiLCJyb2xlIjoiYWRtaW4ifQ.s', user: { id: '1', role: 'viewer' } });
      expect(await p).toBeTrue();
      expect(service.getToken()).toBe('h.eyJpZCI6IjEiLCJyb2xlIjoiYWRtaW4ifQ.s');
      expect(service.getRole()).toBe('viewer');
    });

    it('returns false and stores nothing for a rejected code', async () => {
      const p = service.exchangeLoginCode('bad');
      http.expectOne('/api/auth/exchange').flush({ error: 'Invalid' }, { status: 400, statusText: 'Bad Request' });
      expect(await p).toBeFalse();
      expect(service.getToken()).toBeNull();
    });

    it('keeps the MFA challenge (no session) when the exchange answers mfa_required (#24)', async () => {
      const p = service.exchangeLoginCode('code');
      http.expectOne('/api/auth/exchange').flush({ mfa_required: true, challengeToken: 'challenge-1' });
      expect(await p).toBe('mfa_required');
      expect(service.getToken()).toBeNull();
      expect(service.getPendingChallenge()).toBe('challenge-1');
    });

    it('password login with MFA stores the challenge, then the challenge step stores the session (#24)', async () => {
      let res: any;
      service.login('a@example.com', 'pw').subscribe((r) => (res = r));
      http.expectOne('/api/auth/login').flush({ mfa_required: true, challengeToken: 'challenge-2' });
      expect(res.mfa_required).toBeTrue();
      expect(service.getToken()).toBeNull();
      const done = service.completeMfaChallenge('123456');
      const req = http.expectOne('/api/auth/mfa/challenge');
      expect(req.request.body).toEqual({ challengeToken: 'challenge-2', code: '123456' });
      req.flush({ token: fakeMfaToken, user: { id: '1', role: 'admin' } });
      await done;
      expect(service.getToken()).toBe(fakeMfaToken);
      expect(service.getPendingChallenge()).toBeNull();
    });

    it('detects an enrolment-only session from the mfa_enroll claim (#24)', () => {
      localStorage.setItem('plat_auth_token', `h.${btoa(JSON.stringify({ id: '1', mfa_enroll: true }))}.s`);
      expect(service.mfaEnrollmentRequired()).toBeTrue();
      localStorage.setItem('plat_auth_token', `h.${btoa(JSON.stringify({ id: '1' }))}.s`);
      expect(service.mfaEnrollmentRequired()).toBeFalse();
    });

    it('loads the role from /api/users/me, ignoring JWT claims', async () => {
      const p = service.loadProfile();
      http.expectOne('/api/users/me').flush({ id: '1', role: 'developer' });
      expect(await p).toBeTrue();
      expect(service.getRole()).toBe('developer');
      expect(service.profileVerified).toBeTrue();
    });
  });

  describe('safeReturnUrl', () => {
    it('allows app-relative paths', () => {
      expect(safeReturnUrl('/oauth/authorize?client_id=argocd')).toBe('/oauth/authorize?client_id=argocd');
    });
    it('rejects absolute, protocol-relative and backslash URLs', () => {
      for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '', null]) {
        expect(safeReturnUrl(bad)).toBeNull();
      }
    });
  });
});
