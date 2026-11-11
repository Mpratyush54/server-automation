import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { SidebarComponent } from './sidebar.component';
import { AuthService } from '../../services/auth.service';

describe('SidebarComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['isDevOps', 'isAdmin', 'isTechLeadOrDevOps', 'canManageUsers', 'logout']);

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
    authService.isAdmin.and.returnValue(false);
    authService.canManageUsers.and.returnValue(false);
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

  it('is hidden off-canvas on mobile until opened', () => {
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.componentInstance.isMobile = true;
    fixture.componentInstance.isOpen = false;
    fixture.detectChanges();
    const aside = (fixture.nativeElement as HTMLElement).querySelector('aside')!;
    expect(aside.classList).toContain('sidebar-drawer');
    expect(aside.classList).not.toContain('sidebar-drawer-open');

    fixture.componentRef.setInput('isOpen', true);
    fixture.detectChanges();
    expect(aside.classList).toContain('sidebar-drawer-open');
  });

  it('emits navigate when a link is clicked', () => {
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    const spy = jasmine.createSpy('navigate');
    fixture.componentInstance.navigate.subscribe(spy);
    const link = (fixture.nativeElement as HTMLElement).querySelector('a[href="/projects"]') as HTMLElement;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(spy).toHaveBeenCalled();
  });

  it('does not emit navigate for non-link clicks', () => {
    const fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
    const spy = jasmine.createSpy('navigate');
    fixture.componentInstance.navigate.subscribe(spy);
    ((fixture.nativeElement as HTMLElement).querySelector('aside') as HTMLElement).click();
    expect(spy).not.toHaveBeenCalled();
  });
});
