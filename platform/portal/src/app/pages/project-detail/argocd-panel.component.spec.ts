import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ArgocdPanelComponent } from './argocd-panel.component';

describe('ArgocdPanelComponent', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [ArgocdPanelComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }));
  afterEach(() => TestBed.inject(HttpTestingController).verify());
  it('renders conditions verbatim as text and shows branch, revision and operation error', () => {
    const fixture = TestBed.createComponent(ArgocdPanelComponent);
    fixture.componentInstance.status = { connected: true, branch: 'master', sync: { revision: 'abc123' }, conditions: [{ type: 'ComparisonError', message: 'path not found: <k8s>' }], operationState: { phase: 'Failed', message: 'manifest generation error' } };
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('path not found: <k8s>');
    expect(el.querySelector('k8s')).toBeNull();
    expect(el.textContent).toContain('master'); expect(el.textContent).toContain('abc123');
    expect(el.textContent).toContain('manifest generation error');
  });
  it('posts the action, disables buttons while loading, then asks for updated status', async () => {
    const fixture = TestBed.createComponent(ArgocdPanelComponent);
    const c = fixture.componentInstance; c.project = { id: 'p' }; c.status = { connected: true };
    spyOn(c.reload, 'emit');
    const action = c.act('sync'); fixture.detectChanges();
    expect(Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).every(b => b.disabled)).toBeTrue();
    const req = TestBed.inject(HttpTestingController).expectOne('/api/projects/p/argocd/sync');
    expect(req.request.method).toBe('POST'); expect(req.request.body).toEqual({ env: 'development' });
    req.flush({ accepted: true }); await action;
    expect(c.busy).toBeNull(); expect(c.reload.emit).toHaveBeenCalled();
  });
  it('shows permission errors and clears loading state', async () => {
    const fixture = TestBed.createComponent(ArgocdPanelComponent);
    const c = fixture.componentInstance; c.project = { id: 'p' };
    const action = c.act('refresh');
    TestBed.inject(HttpTestingController).expectOne('/api/projects/p/argocd/refresh').flush({ error: 'Forbidden: requires project role developer or higher' }, { status: 403, statusText: 'Forbidden' });
    await action; fixture.detectChanges();
    expect(c.busy).toBeNull(); expect(fixture.nativeElement.textContent).toContain('Forbidden: requires project role developer or higher');
  });
});
