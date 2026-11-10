import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { AuthService } from '../../services/auth.service';
import { MfaService } from '../../services/mfa.service';

describe('MfaEnrollComponent (forced enrolment, #24)', () => {
  let auth: jasmine.SpyObj<AuthService>;
  let router: Router;

  beforeEach(async () => {
    auth = jasmine.createSpyObj('AuthService', ['isAuthenticated', 'getUser', 'logout', 'replaceSession']);
    await TestBed.configureTestingModule({
      imports: [MfaEnrollComponent],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: auth },
        { provide: MfaService, useValue: jasmine.createSpyObj('MfaService', ['enroll', 'verify']) },
      ],
    }).compileComponents();
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
  });

  it('explains why enrolment is required and continues to the dashboard when done', () => {
    auth.isAuthenticated.and.returnValue(true);
    auth.getUser.and.returnValue({ role: 'admin', email: 'admin@example.com' });
    const fixture = TestBed.createComponent(MfaEnrollComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Your role (admin) requires two-factor authentication');
    expect(fixture.nativeElement.querySelector('app-mfa-enrollment')).toBeTruthy();
    fixture.componentInstance.done();
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard']);
  });

  it('sends visitors without a session to login', () => {
    auth.isAuthenticated.and.returnValue(false);
    const fixture = TestBed.createComponent(MfaEnrollComponent);
    fixture.detectChanges();
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });
});
