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
