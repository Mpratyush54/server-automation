import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { NewProjectComponent } from './new-project.component';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { DialogService, ToastService } from '../../shared/feedback/feedback.service';

const created = {
  id: 'p-new', name: 'shop',
  environments: [{ id: 'e-dev', name: 'development' }, { id: 'e-stg', name: 'staging' }, { id: 'e-prod', name: 'production' }],
};

describe('NewProjectComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let dialog: jasmine.SpyObj<DialogService>;
  let toast: jasmine.SpyObj<ToastService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', [
      'getProjects', 'getIntegrations', 'getUsers', 'createProject', 'provisionDatabase', 'setEnvironmentVar',
      'updateProjectPrivacyConsentDefaults', 'updateProjectPrivacyScrubbing', 'addProjectMember',
    ]);
    dialog = jasmine.createSpyObj('DialogService', ['confirm']);
    toast = jasmine.createSpyObj('ToastService', ['ok', 'error']);
    api.getProjects.and.returnValue(of([{ id: 'p1', name: 'blog' }]));
    api.getIntegrations.and.returnValue(throwError(() => ({ status: 403 })));
    api.getUsers.and.returnValue(of([{ id: 'me', name: 'Asha' }, { id: 'u-ben', name: 'Ben', email: 'ben@example.com' }]));
    await TestBed.configureTestingModule({
      imports: [NewProjectComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { getUser: () => ({ id: 'me', role: 'admin' }) } },
        { provide: DialogService, useValue: dialog },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(NewProjectComponent);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).match(() => true).forEach((r) => r.flush({ github: { connected: false }, gitlab: { connected: false } }));
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  const q = (f: any, id: string) => f.nativeElement.querySelector(`[data-testid="${id}"]`);

  it('keeps Next disabled with a plain reason until the name is valid', async () => {
    const f = await render();
    expect(q(f, 'np-next').disabled).toBeTrue();
    expect(q(f, 'np-reason').textContent).toContain('Enter a name');
    f.componentInstance.draft.name = 'blog';
    f.detectChanges();
    expect(q(f, 'np-reason').textContent).toContain('already exists');
    f.componentInstance.draft.name = 'shop';
    f.detectChanges();
    expect(q(f, 'np-next').disabled).toBeFalse();
    expect(q(f, 'np-reason')).toBeNull();
  });

  it('moves between steps, keeps what was typed and blocks steps after an invalid one', async () => {
    const f = await render();
    const c = f.componentInstance;
    expect(c.canVisit(3)).toBeFalse();
    c.draft.name = 'shop';
    c.next();
    expect(c.current.id).toBe('code');
    c.draft.repositoryUrl = 'https://github.com/acme/shop';
    c.next();
    expect(c.current.id).toBe('environments');
    c.back();
    c.back();
    expect(c.current.id).toBe('app');
    expect(c.draft.repositoryUrl).toBe('https://github.com/acme/shop');
    expect(c.stepState(1)).toBe('done');
    c.goTo(6);
    expect(c.current.id).toBe('review');
    c.draft.domain = 'https://bad';
    expect(c.canVisit(6)).toBeFalse();
  });

  it('shows the environment address preview from the base domain', async () => {
    const f = await render();
    const c = f.componentInstance;
    c.draft.name = 'shop';
    c.draft.domain = 'example.com';
    c.goTo(2);
    f.detectChanges();
    const hosts = Array.from(f.nativeElement.querySelectorAll('[data-testid="np-host"]')).map((e: any) => e.textContent.trim());
    expect(hosts).toEqual(['shop-development-<code>.example.com', 'shop-staging-<code>.example.com', 'shop-production-<code>.example.com']);
  });

  it('creates everything in order and retries only the item that failed', async () => {
    api.createProject.and.returnValue(of(created));
    api.provisionDatabase.and.returnValue(of({ dbName: 'shop_production', connectionString: 'postgresql://u:p@h:5432/shop_production' }));
    api.setEnvironmentVar.and.returnValues(throwError(() => ({ status: 400, error: { error: 'SECRETS_ENCRYPTION_KEY not configured' } })), of({}));
    api.addProjectMember.and.returnValue(of({}));
    const f = await render();
    const c = f.componentInstance;
    c.draft.name = 'shop';
    c.draft.databases.production = true;
    c.draft.variables = [{ key: 'TOKEN', value: 's3cret', secret: true, scope: 'staging' }];
    c.draft.members = [{ userId: 'u-ben', email: '', role: 'developer' }];

    await c.create();
    f.detectChanges();

    expect(api.createProject).toHaveBeenCalledWith({ name: 'shop', stack: 'nodejs' });
    expect(api.provisionDatabase).toHaveBeenCalledWith('p-new', 'production');
    expect(api.setEnvironmentVar).toHaveBeenCalledWith('p-new', 'TOKEN', { environmentId: 'e-stg', value: 's3cret', secret: true });
    expect(api.addProjectMember).toHaveBeenCalledWith('p-new', { userId: 'u-ben', role: 'developer' });
    expect(c.phase).toBe('partial');
    const failed = c.items.find((i) => i.kind === 'variable')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('SECRETS_ENCRYPTION_KEY');
    expect(f.nativeElement.textContent).toContain('postgresql://u:p@h:5432/shop_production');
    expect(toast.error).toHaveBeenCalled();

    (q(f, 'np-retry-' + failed.id) as HTMLButtonElement).click();
    await f.whenStable();
    expect(api.createProject).toHaveBeenCalledTimes(1);
    expect(api.provisionDatabase).toHaveBeenCalledTimes(1);
    expect(api.setEnvironmentVar).toHaveBeenCalledTimes(2);
    expect(c.items.every((i) => i.status === 'done')).toBeTrue();
    expect(c.phase).toBe('done');
    expect(toast.ok).toHaveBeenCalled();
  });

  it('when the project itself fails, nothing else runs and the form comes back intact', async () => {
    api.createProject.and.returnValue(throwError(() => ({ status: 409, error: { error: 'Project name already exists' } })));
    const f = await render();
    const c = f.componentInstance;
    c.draft.name = 'shop';
    c.draft.databases.staging = true;
    await c.create();
    expect(c.items[0].status).toBe('failed');
    expect(c.items[0].error).toContain('pick another name');
    expect(c.items[1].status).toBe('blocked');
    expect(api.provisionDatabase).not.toHaveBeenCalled();
    c.editAgain();
    expect(c.phase).toBe('edit');
    expect(c.draft.name).toBe('shop');
    expect(c.draft.databases.staging).toBeTrue();
  });

  it('explains a repository conflict without blaming the project name', async () => {
    api.createProject.and.returnValue(throwError(() => ({ status: 409, error: { error: 'This repository is already linked to another project', code: 'repository_in_use' } })));
    const f = await render();
    const c = f.componentInstance;
    c.draft.name = 'shop';
    await c.create();
    expect(c.items[0].status).toBe('failed');
    expect(c.items[0].error).toContain('already linked to another project');
    expect(c.items[0].error).toContain('choose another repository');
    expect(c.items[0].error).not.toContain('name');
  });

  it('asks before leaving with unsaved input', async () => {
    const f = await render();
    const c = f.componentInstance;
    expect(await c.confirmLeave()).toBeTrue();
    expect(dialog.confirm).not.toHaveBeenCalled();
    c.draft.name = 'shop';
    dialog.confirm.and.resolveTo(false);
    expect(await c.confirmLeave()).toBeFalse();
    expect(dialog.confirm.calls.mostRecent().args[0].title).toContain('Leave without creating');
  });

  it('does not offer the current user in the team list', async () => {
    const f = await render();
    expect(f.componentInstance.users.map((u) => u.id)).toEqual(['u-ben']);
  });
});
