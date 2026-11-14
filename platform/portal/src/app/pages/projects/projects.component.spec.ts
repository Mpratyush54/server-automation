import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ProjectsComponent, VIEW_KEY, filterRows, sortRows, toRows } from './projects.component';
import { ApiService } from '../../services/api.service';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';

const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();

const sample = () => [
  { id: 'p-shop', name: 'shop', stack: 'nodejs', repositoryUrl: 'https://github.com/acme/shop', domain: 'shop.example.com',
    environments: [{ id: 'e1', name: 'production', domain: 'shop.example.com' }],
    deployments: [{ id: 'd1', version: 'v1.8.2', status: 'deployed', environmentId: 'e1', createdAt: ago(2), deployedBy: 'asha@example.com' }] },
  { id: 'p-api', name: 'billing-api', stack: 'python', repositoryUrl: 'git@gitlab.com:acme/billing-api.git',
    environments: [{ id: 'e2', name: 'production' }],
    deployments: [{ id: 'x1', version: 'v0.9.3', status: 'failed', environmentId: 'e2', createdAt: ago(14) }] },
  { id: 'p-blog', name: 'blog', stack: 'static', description: 'Company blog',
    environments: [{ id: 'e3', name: 'production' }], deployments: [] },
  { id: 'p-alpha', name: 'alpha', stack: 'angular', environments: [{ id: 'e4', name: 'staging' }],
    deployments: [{ id: 'a1', version: 'v0.1.0', status: 'deployed', environmentId: 'e4', createdAt: ago(600) }] },
];

describe('projects list model', () => {
  it('reuses the dashboard status rules and adds repository and stack', () => {
    const rows = toRows(sample());
    const shop = rows.find((r) => r.id === 'p-shop')!;
    expect(shop.status).toBe('Running');
    expect(shop.tone).toBe('ok');
    expect(shop.provider).toBe('GitHub');
    expect(shop.repo).toBe('acme/shop');
    expect(shop.stack).toBe('Node.js');
    expect(shop.lastVersion).toBe('v1.8.2');
    expect(shop.lastBy).toBe('asha');
    const api = rows.find((r) => r.id === 'p-api')!;
    expect(api.status).toBe('Needs attention');
    expect(api.provider).toBe('GitLab');
    expect(api.repo).toBe('acme/billing-api');
    expect(rows.find((r) => r.id === 'p-blog')!.status).toBe('Not deployed yet');
  });

  it('filters by status and search text', () => {
    const rows = toRows(sample());
    expect(filterRows(rows, '', 'attention', 'name').map((r) => r.id)).toEqual(['p-api']);
    expect(filterRows(rows, '', 'running', 'name').map((r) => r.id)).toEqual(['p-alpha', 'p-shop']);
    expect(filterRows(rows, '', 'idle', 'name').map((r) => r.id)).toEqual(['p-blog']);
    expect(filterRows(rows, 'GITLAB', 'all', 'name').map((r) => r.id)).toEqual(['p-api']);
    expect(filterRows(rows, 'company', 'all', 'name').map((r) => r.id)).toEqual(['p-blog']);
    expect(filterRows(rows, 'shop', 'attention', 'name')).toEqual([]);
  });

  it('sorts by recent deployment, name and status', () => {
    const rows = toRows(sample());
    expect(sortRows(rows, 'recent').map((r) => r.id)).toEqual(['p-shop', 'p-api', 'p-alpha', 'p-blog']);
    expect(sortRows(rows, 'name').map((r) => r.name)).toEqual(['alpha', 'billing-api', 'blog', 'shop']);
    expect(sortRows(rows, 'status').map((r) => r.id)).toEqual(['p-api', 'p-alpha', 'p-shop', 'p-blog']);
  });
});

describe('ProjectsComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<DialogService>;
  let toast: jasmine.SpyObj<ToastService>;

  beforeEach(async () => {
    try { localStorage.removeItem(VIEW_KEY); } catch { /* ignore */ }
    api = jasmine.createSpyObj('ApiService', ['getProjects', 'deleteProject']);
    dialog = jasmine.createSpyObj('DialogService', ['confirm']);
    toast = jasmine.createSpyObj('ToastService', ['ok', 'error']);
    await TestBed.configureTestingModule({
      imports: [ProjectsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: DialogService, useValue: dialog },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();
    api.getProjects.and.returnValue(of(sample()));
  });

  async function render() {
    const fixture = TestBed.createComponent(ProjectsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('loads projects and shows one row each, recently deployed first', async () => {
    const fixture = await render();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="pj-row"]');
    expect(rows.length).toBe(4);
    expect(rows[0].textContent).toContain('shop');
    expect(rows[0].textContent).toContain('shop.example.com');
    expect(rows[0].textContent).toContain('v1.8.2');
  });

  it('shows the welcome state pointing to the wizard when there are no projects', async () => {
    api.getProjects.and.returnValue(of([]));
    const fixture = await render();
    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('[data-testid="pj-empty-new"]');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/projects/new');
  });

  it('filters with the status chips and shows counts', async () => {
    const fixture = await render();
    const c = fixture.componentInstance;
    expect(c.counts).toEqual({ all: 4, attention: 1, running: 2, idle: 1 });
    (fixture.nativeElement.querySelector('[data-testid="pj-filter-attention"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="pj-row"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('billing-api');
  });

  it('remembers the grid layout', async () => {
    const fixture = await render();
    fixture.componentInstance.setView('grid');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="pj-grid"]')).toBeTruthy();
    expect(localStorage.getItem(VIEW_KEY)).toBe('grid');
    const again = await render();
    expect(again.componentInstance.view).toBe('grid');
  });

  it('asks to type the project name before deleting', async () => {
    dialog.confirm.and.resolveTo(true);
    api.deleteProject.and.returnValue(of({}));
    const fixture = await render();
    await fixture.componentInstance.delete({ id: 'p-shop', name: 'shop' });
    const opts = dialog.confirm.calls.mostRecent().args[0];
    expect(opts.danger).toBeTrue();
    expect(opts.typeToConfirm).toBe('shop');
    expect(api.deleteProject).toHaveBeenCalledWith('p-shop');
    expect(fixture.componentInstance.rows.length).toBe(3);
    expect(toast.ok).toHaveBeenCalled();
  });

  it('does not delete when the dialog is cancelled', async () => {
    dialog.confirm.and.resolveTo(false);
    const fixture = await render();
    await fixture.componentInstance.delete({ id: 'p-shop', name: 'shop' });
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(fixture.componentInstance.rows.length).toBe(4);
  });

  it('keeps the project and says why when delete fails', async () => {
    dialog.confirm.and.resolveTo(true);
    api.deleteProject.and.returnValue(throwError(() => ({ status: 403, error: { error: 'Forbidden' } })));
    const fixture = await render();
    await fixture.componentInstance.delete({ id: 'p-shop', name: 'shop' });
    expect(fixture.componentInstance.rows.length).toBe(4);
    expect(toast.error).toHaveBeenCalledWith(jasmine.stringContaining('Forbidden'));
  });

  it('opens the actions menu and moves focus with the arrow keys', async () => {
    const fixture = await render();
    const btn: HTMLButtonElement = fixture.nativeElement.querySelector('[data-testid="pj-menu-btn"]');
    btn.click();
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 0));
    const menu: HTMLElement = fixture.nativeElement.querySelector('[role="menu"]');
    const items = menu.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement?.textContent).toContain('Delete project');
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});
