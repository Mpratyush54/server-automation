import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpContext, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { authInterceptor, SKIP_SESSION_AUTH } from './auth.interceptor';

describe('authInterceptor', () => {
  const sessionJwt = 'header.session.sig';
  let http: HttpClient;
  let backend: HttpTestingController;
  let navigateByUrl: jasmine.Spy;

  beforeEach(() => {
    localStorage.setItem('plat_auth_token', sessionJwt);
    localStorage.setItem('plat_user_profile', '{}');
    navigateByUrl = jasmine.createSpy('navigateByUrl').and.resolveTo(true);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: { url: '/playground', navigateByUrl } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    backend.verify();
    localStorage.removeItem('plat_auth_token');
    localStorage.removeItem('plat_user_profile');
  });

  it('attaches the session JWT when the request has no Authorization header', () => {
    http.get('/api/projects').subscribe();
    const req = backend.expectOne('/api/projects');
    expect(req.request.headers.get('Authorization')).toBe(`Bearer ${sessionJwt}`);
    req.flush([]);
  });

  it('does not overwrite a caller-supplied Authorization header', () => {
    const headers = new HttpHeaders({ Authorization: 'Bearer plat_agent_abc123' });
    http.get('/api/agent-tokens/me', { headers }).subscribe();
    const req = backend.expectOne('/api/agent-tokens/me');
    expect(req.request.headers.get('Authorization')).toBe('Bearer plat_agent_abc123');
    req.flush({});
  });

  it('sends no session JWT when SKIP_SESSION_AUTH is set without a header', () => {
    const context = new HttpContext().set(SKIP_SESSION_AUTH, true);
    http.get('/api/projects', { context }).subscribe();
    const req = backend.expectOne('/api/projects');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    req.flush([]);
  });

  it('keeps the session when a caller-supplied token gets a 401', () => {
    const headers = new HttpHeaders({ Authorization: 'Bearer wrong' });
    http.get('/api/agent-tokens/me', { headers }).subscribe({ error: () => undefined });
    backend.expectOne('/api/agent-tokens/me').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(localStorage.getItem('plat_auth_token')).toBe(sessionJwt);
    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('ends the session when the session JWT gets a 401', () => {
    http.get('/api/projects').subscribe({ error: () => undefined });
    backend.expectOne('/api/projects').flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(localStorage.getItem('plat_auth_token')).toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/login');
  });
});
