import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { GitConnectComponent } from './git-connect.component';

describe('GitConnectComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GitConnectComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function flushLoad(status: any, installations: any[] = []) {
    http.expectOne('/api/settings/integrations/git').flush(status);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r));
    http.expectOne('/api/settings/integrations/github/installations').flush({ installations });
  }

  it('shows provider status from the API', async () => {
    const fixture = TestBed.createComponent(GitConnectComponent);
    const c = fixture.componentInstance;
    const loading = c.load();
    await flushLoad({
      github: { connected: true, slug: 'my-app', installations: 1, health: { ok: true } },
      gitlab: { connected: false },
      warnings: ['not public'],
    }, [{ installationId: '1', account: 'acme', repositories: [], projects: [] }]);
    await loading;
    expect(c.gh.slug).toBe('my-app');
    expect(c.gl.connected).toBeFalse();
    expect(c.installations.length).toBe(1);
  });

  it('surfaces the GitLab manual fallback with the redirect URI', async () => {
    const fixture = TestBed.createComponent(GitConnectComponent);
    const c = fixture.componentInstance;
    c.isAdmin = true;
    c.glForm.token = 'glpat-x';
    const p = c.connectGitlab();
    await Promise.resolve();
    http.expectOne('/api/settings/integrations/gitlab/connect').flush(
      { error: 'Create it in the UI.', manualRequired: true, redirectUri: 'https://p.example/api/auth/gitlab/callback', scopes: 'read_user read_api' },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await p;
    expect(c.messageOk).toBeFalse();
    expect(c.message).toContain('https://p.example/api/auth/gitlab/callback');
  });

  it('labels credential sources', () => {
    const c = TestBed.createComponent(GitConnectComponent).componentInstance;
    expect(c.sourceLabel('app')).toBe('the connected app');
    expect(c.sourceLabel('manual')).toBe('manual entry');
    expect(TestBed.inject(Router)).toBeTruthy();
  });
});
