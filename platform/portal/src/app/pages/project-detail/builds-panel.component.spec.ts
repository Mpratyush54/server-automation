import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BuildsPanelComponent } from './builds-panel.component';

describe('BuildsPanelComponent', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [BuildsPanelComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  const result = { enabled: true, builds: [{ id: 'b', commitSha: 'abcdef1234567890', branch: 'main', status: 'building', triggeredBy: 'push' }], environments: [{ id: 'e', name: 'staging', buildOnPush: false, buildBranch: 'main' }] };

  it('renders status, commit, branch and escaped logs', async () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance; c.projectId = 'p';
    const refresh = c.refresh(); TestBed.inject(HttpTestingController).expectOne('/api/projects/p/builds').flush(result); await refresh;
    const logs = c.selectBuild('b'); TestBed.inject(HttpTestingController).expectOne('/api/projects/p/builds/b/logs').flush({ logs: '<script>sample</script>' }); await logs;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.status.status-warn').textContent).toBe('building');
    expect(fixture.nativeElement.textContent).toContain('abcdef123456');
    expect(fixture.nativeElement.querySelector('pre').textContent).toContain('<script>sample</script>');
    expect(fixture.nativeElement.querySelector('script')).toBeNull(); fixture.destroy();
  });
  it('marks superseded builds as cancelled and shows the reason', async () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance; c.projectId = 'p';
    const refresh = c.refresh();
    TestBed.inject(HttpTestingController).expectOne('/api/projects/p/builds').flush({ ...result, builds: [{ id: 'b', commitSha: 'abcdef1234567890', branch: 'main', status: 'cancelled', triggeredBy: 'push', error: 'Superseded by a newer push (0123456789ab)' }] });
    await refresh; fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.status.status-down').textContent).toBe('cancelled');
    expect(fixture.nativeElement.querySelector('.build-reason').textContent).toContain('Superseded by a newer push');
    fixture.destroy();
  });
  it('queues the selected environment and branch, then refreshes history', async () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance;
    c.projectId = 'p'; c.environmentId = 'e'; c.branch = 'main';
    const action = c.buildNow(); const http = TestBed.inject(HttpTestingController);
    const post = http.expectOne('/api/projects/p/builds'); expect(post.request.body).toEqual({ environmentId: 'e', branch: 'main' }); post.flush({ id: 'b' });
    await Promise.resolve(); await Promise.resolve(); http.expectOne('/api/projects/p/builds').flush(result); await action;
    expect(c.busy).toBeFalse(); expect(c.builds.length).toBe(1); fixture.destroy();
  });
  it('saves per-environment source build settings', async () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance; c.projectId = 'p';
    const save = c.saveSettings({ id: 'e', buildOnPush: true, buildBranch: 'release' });
    const req = TestBed.inject(HttpTestingController).expectOne('/api/projects/p/builds/settings');
    expect(req.request.method).toBe('PATCH'); expect(req.request.body).toEqual({ environmentId: 'e', buildOnPush: true, branch: 'release' });
    req.flush({}); await save; fixture.destroy();
  });
  it('ignores stale history after switching projects and stops polling on destroy', async () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance; c.projectId = 'old'; c.ngOnChanges();
    const http = TestBed.inject(HttpTestingController); const old = http.expectOne('/api/projects/old/builds');
    c.projectId = 'new'; c.ngOnChanges();
    http.expectOne('/api/projects/new/builds').flush({ enabled: false, builds: [], environments: [] });
    old.flush(result); await Promise.resolve(); await Promise.resolve();
    expect(c.builds).toEqual([]); fixture.destroy();
  });
  it('shows installer-disabled copy and hides mutation controls for viewers', () => {
    const fixture = TestBed.createComponent(BuildsPanelComponent); const c = fixture.componentInstance;
    c.loaded = true; c.enabled = false; fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Source builds are disabled');
    expect(fixture.nativeElement.textContent).not.toContain('Build now'); fixture.destroy();
  });
});
