import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { SettingsComponent } from './settings.component';
import { ApiService } from '../../services/api.service';
import { StepUpService } from '../../services/step-up.service';

describe('SettingsComponent rotate passwords', () => {
  let api: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['rotateSecrets', 'listOperations']);
    api.listOperations.and.returnValue(of([{ id: 'op-1' }]) as any);
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ApiService, useValue: api },
        { provide: StepUpService, useValue: { run: (fn: () => Promise<unknown>) => fn() } },
      ],
    }).compileComponents();
  });

  function create() {
    const c = TestBed.createComponent(SettingsComponent).componentInstance;
    c.rotateConfirm = 'ROTATE';
    return c;
  }

  it('explains how to read the new admin password when the answer is lost', async () => {
    api.rotateSecrets.and.returnValue(throwError(() => ({ status: 502, message: 'Bad Gateway' })) as any);
    const c = create();
    await c.rotateSecrets();
    expect(c.rotateAnswerLost).toBeTrue();
    expect(c.rotateValues).toBeNull();
  });

  it('does not show the recovery note when the API refused the request', async () => {
    api.rotateSecrets.and.returnValue(throwError(() => ({ status: 409 })) as any);
    const c = create();
    await c.rotateSecrets();
    expect(c.rotateAnswerLost).toBeFalse();
    expect(c.rotateError).toContain('already in progress');
  });

  it('shows the new values when the answer arrives', async () => {
    api.rotateSecrets.and.returnValue(of({ values: { ADMIN_PASSWORD: 'x' }, results: [], operationId: 'op-2' }) as any);
    const c = create();
    await c.rotateSecrets();
    expect(c.rotateAnswerLost).toBeFalse();
    expect(c.rotateValues).toEqual({ ADMIN_PASSWORD: 'x' });
    expect(c.rotationOperationId).toBe('op-2');
  });
});

describe('SettingsComponent recovery backups', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        provideRouter([]), provideHttpClient(), provideHttpClientTesting(),
        { provide: ApiService, useValue: jasmine.createSpyObj<ApiService>('ApiService', ['getBackupStatus']) },
        { provide: StepUpService, useValue: { run: (fn: () => Promise<unknown>) => fn() } },
      ],
    }).compileComponents();
  });

  async function render(items: any[]) {
    const fixture = TestBed.createComponent(SettingsComponent);
    const c = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    c.isDevOps = true;
    c.activeTab = 'security';
    c.backupStatus = items;
    fixture.detectChanges();
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="backup-size"]'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
  }

  it('shows the size when it is known and hides it instead of "0 B" when it is not', async () => {
    const at = '2026-11-18T03:00:00Z';
    const sizes = await render([
      { operation: 'backup', status: { success: true, finishedAt: at, durationSeconds: 42, bytes: 2_500_000 } },
      { operation: 'restore-test', status: { success: true, finishedAt: at, durationSeconds: 9, bytes: 0 } },
    ]);
    expect(sizes[0]).toBe('2.5 MB in 42 s');
    expect(sizes[1]).toBe('9 s');
    expect(sizes.join(' ')).not.toContain('0 B');
  });
});
