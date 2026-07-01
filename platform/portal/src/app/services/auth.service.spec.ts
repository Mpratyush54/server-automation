import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';

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

  describe('logout', () => {
    it('should clear localStorage', () => {
      localStorage.setItem('plat_auth_token', 'token');
      localStorage.setItem('plat_user_profile', '{}');

      service.logout();

      expect(localStorage.getItem('plat_auth_token')).toBeNull();
      expect(localStorage.getItem('plat_user_profile')).toBeNull();
    });
  });
});
