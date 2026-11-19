import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { StepUpService } from '../../services/step-up.service';
import { DeleteProjectDialogComponent, stepLabel } from './delete-project-dialog.component';

const STEPS = ['prepare', 'lock-databases', 'back-up-databases', 'stop-apps', 'remove-namespaces', 'remove-monitoring',
  'revoke-access', 'remove-databases', 'remove-data', 'finish'];

function view(status: string, opts: { failedAt?: string; doneUpTo?: number; error?: string; deleteDatabases?: boolean; result?: any } = {}) {
  const steps = STEPS.map((name, i) => ({
    name,
    status: name === opts.failedAt ? 'failed' : i < (opts.doneUpTo ?? 0) ? 'succeeded' : 'pending',
    error: name === opts.failedAt ? opts.error || 'boom' : null,
    output: null,
  }));
  return { status, deleteDatabases: !!opts.deleteDatabases, operation: { id: 'op-1', status, steps, error: opts.error ? `${opts.failedAt}: ${opts.error}` : null, result: opts.result || null } };
}

describe('DeleteProjectDialogComponent', () => {
  let api: jasmine.SpyObj<ApiService>;
  let stepUp: jasmine.SpyObj<StepUpService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj('ApiService', ['deleteProject', 'getProjectDeletion']);
    stepUp = jasmine.createSpyObj('StepUpService', ['run']);
    // Default: the action runs as is (no step-up needed).
    stepUp.run.and.callFake((action: () => Promise<any>) => action());
    api.getProjectDeletion.and.returnValue(of({ status: 'none', operation: null }));
    await TestBed.configureTestingModule({
      imports: [DeleteProjectDialogComponent],
      providers: [{ provide: ApiService, useValue: api }, { provide: StepUpService, useValue: stepUp }],
    }).compileComponents();
  });

  async function open(project = { id: 'p1', name: 'shop' }) {
    const fixture = TestBed.createComponent(DeleteProjectDialogComponent);
    fixture.componentInstance.pollMs = 5;
    fixture.componentRef.setInput('project', project);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  const q = (f: any, id: string) => f.nativeElement.querySelector(`[data-testid="${id}"]`);
  const type = (f: any, text: string) => {
    const input = q(f, 'pd-typed') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const settle = async (f: any, ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
    await f.whenStable();
    f.detectChanges();
  };

  it('explains what is removed and only enables delete for the exact name', async () => {
    const f = await open();
    const text = q(f, 'delete-project-dialog').textContent;
    expect(text).toContain('Delete shop?');
    expect(text).toContain('Every database is backed up first');
    expect(text).toContain('Also delete the databases (a backup is made first)');
    const confirm = q(f, 'pd-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBeTrue();
    type(f, 'Shop');
    expect(confirm.disabled).toBeTrue();
    type(f, 'shop');
    expect(confirm.disabled).toBeFalse();
  });

  it('sends the name and the database choice through the step-up, then shows each step until done', async () => {
    api.deleteProject.and.returnValue(of({ operationId: 'op-1', status: 'running' }));
    const f = await open();
    (q(f, 'pd-delete-dbs') as HTMLInputElement).click();
    f.detectChanges();
    type(f, 'shop');
    api.getProjectDeletion.and.returnValues(
      of(view('running', { doneUpTo: 3, deleteDatabases: true })),
      of(view('deleted', { doneUpTo: 10, deleteDatabases: true, result: { backups: [{}, {}], databasesOutcome: 'dropped' } })),
    );
    (q(f, 'pd-confirm') as HTMLButtonElement).click();
    await settle(f);
    expect(stepUp.run).toHaveBeenCalled();
    expect(stepUp.run.calls.mostRecent().args[1]).toContain('delete shop');
    expect(api.deleteProject).toHaveBeenCalledWith('p1', { confirmName: 'shop', deleteDatabases: true });
    await settle(f);
    const steps = Array.from(q(f, 'pd-steps').querySelectorAll('li')) as HTMLElement[];
    expect(steps.length).toBe(10);
    expect(steps[2].textContent).toContain('Back up the databases');
    expect(steps[7].textContent).toContain('Delete the databases');
    expect(steps.every((s) => s.getAttribute('data-status') === 'succeeded')).toBeTrue();
    expect(q(f, 'pd-done').textContent).toContain('2 databases were backed up and then deleted');
    let result = '';
    f.componentInstance.closed.subscribe((r: string) => (result = r));
    (q(f, 'pd-close') as HTMLButtonElement).click();
    expect(result).toBe('deleted');
  });

  it('shows a clear error and retries a delete that stopped mid-way', async () => {
    api.getProjectDeletion.and.returnValue(of(view('failed', { doneUpTo: 4, failedAt: 'remove-namespaces', error: 'cluster API timed out' })));
    const f = await open();
    expect(q(f, 'pd-error').textContent).toContain('cluster API timed out');
    expect(q(f, 'pd-error').textContent).toContain('Try again to finish');
    const failed = q(f, 'pd-steps').querySelector('li[data-status="failed"]') as HTMLElement;
    expect(failed.textContent).toContain('Remove the apps, web addresses and certificates');
    api.deleteProject.and.returnValue(of({ operationId: 'op-2', status: 'running', resumed: true }));
    api.getProjectDeletion.and.returnValue(of(view('deleted', { doneUpTo: 10 })));
    (q(f, 'pd-retry') as HTMLButtonElement).click();
    await settle(f);
    expect(api.deleteProject).toHaveBeenCalledWith('p1', { confirmName: 'shop', deleteDatabases: false });
    expect(f.componentInstance.phase).toBe('deleted');
  });

  it('says why the delete did not start, and keeps the form', async () => {
    api.deleteProject.and.returnValue(throwError(() => ({ status: 409, error: { error: 'Another delete is running' } })));
    const f = await open();
    type(f, 'shop');
    (q(f, 'pd-confirm') as HTMLButtonElement).click();
    await settle(f);
    expect(f.componentInstance.phase).toBe('confirm');
    expect(q(f, 'pd-error').textContent).toContain('The delete did not start: Another delete is running');
  });

  it('does not start when the step-up is cancelled', async () => {
    stepUp.run.and.returnValue(Promise.reject({ status: 401, error: { error: 'step_up_required' } }));
    const f = await open();
    type(f, 'shop');
    (q(f, 'pd-confirm') as HTMLButtonElement).click();
    await settle(f);
    expect(api.deleteProject).not.toHaveBeenCalled();
    expect(f.componentInstance.phase).toBe('confirm');
    expect(q(f, 'pd-error')).toBeTruthy();
  });

  it('after a backup failure, says nothing was deleted and lets the user start again', async () => {
    api.getProjectDeletion.and.returnValue(of(view('aborted', { doneUpTo: 2, failedAt: 'back-up-databases', error: 'Backup failed, nothing was deleted. postgres x (production): disk full' })));
    const f = await open();
    expect(f.componentInstance.phase).toBe('confirm');
    expect(q(f, 'pd-previous').textContent).toContain('Backup failed, nothing was deleted');
  });

  it('labels the database step by the choice made', () => {
    expect(stepLabel('remove-databases', false)).toBe('Keep the databases, locked');
    expect(stepLabel('remove-databases', true)).toBe('Delete the databases');
  });
});
