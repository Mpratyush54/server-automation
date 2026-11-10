import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { StepUpModalComponent } from './step-up-modal.component';
import { StepUpService } from '../services/step-up.service';
import { MfaService } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';

describe('Step-up (#24)', () => {
  let mfa: jasmine.SpyObj<MfaService>;
  let auth: jasmine.SpyObj<AuthService>;
  let stepUp: StepUpService;

  beforeEach(async () => {
    mfa = jasmine.createSpyObj('MfaService', ['stepUp']);
    auth = jasmine.createSpyObj('AuthService', ['replaceSession']);
    await TestBed.configureTestingModule({
      imports: [StepUpModalComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }, { provide: AuthService, useValue: auth }],
    }).compileComponents();
    stepUp = TestBed.inject(StepUpService);
  });

  const stepUpError = { status: 401, error: { error: 'step_up_required', maxAgeSec: 900 } };

  it('reveal flow: on step_up_required asks for a code, steps up and retries the action', async () => {
    mfa.stepUp.and.returnValue(of({ token: 'fresh.token', user: {}, maxAgeSec: 900 }));
    const fixture = TestBed.createComponent(StepUpModalComponent);
    fixture.detectChanges();

    let calls = 0;
    const action = () => (++calls === 1 ? Promise.reject(stepUpError) : Promise.resolve({ value: 's3cret' }));
    const result = stepUp.run(action, 'Reveal API_KEY');

    await fixture.whenStable();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.step-up-modal')).toBeTruthy();
    expect(el.textContent).toContain('Reveal API_KEY');

    fixture.componentInstance.code = '123456';
    await fixture.componentInstance.submit();
    expect(mfa.stepUp).toHaveBeenCalledWith('123456');
    expect(auth.replaceSession).toHaveBeenCalledWith(jasmine.objectContaining({ token: 'fresh.token' }));
    expect(await result).toEqual({ value: 's3cret' });
    expect(calls).toBe(2);
    fixture.detectChanges();
    expect(el.querySelector('.step-up-modal')).toBeNull();
  });

  it('a wrong code keeps the modal open; cancel rejects with the original error', async () => {
    mfa.stepUp.and.returnValue(throwError(() => ({ status: 400, error: { error: 'invalid_code' } })));
    const fixture = TestBed.createComponent(StepUpModalComponent);
    fixture.detectChanges();
    const result = stepUp.run(() => Promise.reject(stepUpError));
    await fixture.whenStable();
    fixture.componentInstance.code = '000000';
    await fixture.componentInstance.submit();
    expect(fixture.componentInstance.error).toContain('not valid');
    expect(fixture.componentInstance.request).not.toBeNull();
    fixture.componentInstance.cancel();
    await expectAsync(result).toBeRejectedWith(stepUpError);
  });

  it('points users without MFA to the profile page', async () => {
    mfa.stepUp.and.returnValue(throwError(() => ({ status: 400, error: { error: 'mfa_not_enrolled' } })));
    const fixture = TestBed.createComponent(StepUpModalComponent);
    fixture.detectChanges();
    const result = stepUp.run(() => Promise.reject(stepUpError));
    await fixture.whenStable();
    fixture.componentInstance.code = '123456';
    await fixture.componentInstance.submit();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.step-up-enrol')).toBeTruthy();
    fixture.componentInstance.cancel();
    await expectAsync(result).toBeRejected();
  });

  it('does not prompt for other errors', async () => {
    const other = { status: 403, error: { error: 'Forbidden' } };
    await expectAsync(stepUp.run(() => Promise.reject(other))).toBeRejectedWith(other);
    expect(stepUp.request$.value).toBeNull();
  });
});
