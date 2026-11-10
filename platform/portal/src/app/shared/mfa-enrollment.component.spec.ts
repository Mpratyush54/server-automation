import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { MfaEnrollmentComponent } from './mfa-enrollment.component';
import { MfaService, recoveryCodesFile } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';

describe('MfaEnrollmentComponent (#24)', () => {
  let mfa: jasmine.SpyObj<MfaService>;
  let auth: jasmine.SpyObj<AuthService>;
  const codes = Array.from({ length: 10 }, (_, i) => `abcde-fgh${i}k`);

  beforeEach(async () => {
    mfa = jasmine.createSpyObj('MfaService', ['enroll', 'verify']);
    auth = jasmine.createSpyObj('AuthService', ['replaceSession']);
    await TestBed.configureTestingModule({
      imports: [MfaEnrollmentComponent],
      providers: [{ provide: MfaService, useValue: mfa }, { provide: AuthService, useValue: auth }],
    }).compileComponents();
  });

  it('shows the QR code from the otpauth URI, verifies the code and shows the recovery codes once', async () => {
    mfa.enroll.and.returnValue(of({ otpauthUri: 'otpauth://totp/x', qrDataUrl: 'data:image/png;base64,AAAA', secret: 'JBSWY3DPEHPK3PXP', issuer: 'Platform' }));
    mfa.verify.and.returnValue(of({ recoveryCodes: codes, token: 'new.session.token', user: { id: '1' } }));
    const fixture = TestBed.createComponent(MfaEnrollmentComponent);
    const cmp = fixture.componentInstance;
    fixture.detectChanges();

    await cmp.start();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect((el.querySelector('.mfa-qr') as HTMLImageElement).src).toContain('data:image/png;base64,AAAA');
    expect(el.querySelector('.mfa-secret')!.textContent).toContain('JBSWY3DPEHPK3PXP');

    cmp.code = '123456';
    await cmp.verify();
    fixture.detectChanges();
    expect(mfa.verify).toHaveBeenCalledWith('123456');
    // The full session replaces the enrolment-only one.
    expect(auth.replaceSession).toHaveBeenCalledWith(jasmine.objectContaining({ token: 'new.session.token' }));
    expect(el.querySelectorAll('.mfa-recovery-codes li').length).toBe(10);

    const done = jasmine.createSpy('completed');
    cmp.completed.subscribe(done);
    expect((el.querySelector('.mfa-done') as HTMLButtonElement).disabled).toBeTrue();
    spyOn(URL, 'createObjectURL').and.returnValue('blob:x');
    spyOn(HTMLAnchorElement.prototype, 'click');
    cmp.download();
    fixture.detectChanges();
    expect((el.querySelector('.mfa-done') as HTMLButtonElement).disabled).toBeFalse();
    cmp.finish();
    expect(done).toHaveBeenCalled();
  });

  it('stays on the verify step after a wrong code', async () => {
    mfa.enroll.and.returnValue(of({ otpauthUri: 'u', qrDataUrl: 'data:image/png;base64,AA', secret: 'S', issuer: 'P' }));
    mfa.verify.and.returnValue(throwError(() => ({ status: 400, error: { error: 'invalid_code' } })));
    const fixture = TestBed.createComponent(MfaEnrollmentComponent);
    const cmp = fixture.componentInstance;
    await cmp.start();
    cmp.code = '000000';
    await cmp.verify();
    expect(cmp.step).toBe('scan');
    expect(cmp.error).toContain('not valid');
    expect(auth.replaceSession).not.toHaveBeenCalled();
  });

  it('recovery code file lists every code', () => {
    const text = recoveryCodesFile(codes, 'admin@example.com');
    for (const c of codes) expect(text).toContain(c);
    expect(text).toContain('admin@example.com');
  });
});
