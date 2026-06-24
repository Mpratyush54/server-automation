import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { SidebarComponent } from './sidebar.component';
import { AuthService } from '../../services/auth.service';

describe('SidebarComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['isDevOps', 'isTechLeadOrDevOps', 'logout']);

    await TestBed.configureTestingModule({
      imports: [SidebarComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: authSpy },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(SidebarComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should set isDevOps based on auth service', () => {
    authService.isDevOps.and.returnValue(true);
    authService.isTechLeadOrDevOps.and.returnValue(true);

    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.isDevOps).toBeTrue();
  });

  it('should set isTechLeadOrDevOps based on auth service', () => {
    authService.isDevOps.and.returnValue(false);
    authService.isTechLeadOrDevOps.and.returnValue(true);

    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.isTechLeadOrDevOps).toBeTrue();
    expect(fixture.componentInstance.isDevOps).toBeFalse();
  });

  it('should call logout', () => {
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.componentInstance.logout();

    expect(authService.logout).toHaveBeenCalled();
  });
});
