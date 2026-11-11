import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should have default pageTitle', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.pageTitle).toBe('Dashboard');
  });

  it('should detect login page from URL', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.isLoginPage).toBeFalse();
  });

  it('should render sidebar when not on login page', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-sidebar')).toBeTruthy();
  });

  describe('responsive shell', () => {
    it('uses an off-canvas drawer below md, closed by default', () => {
      const app = TestBed.createComponent(AppComponent).componentInstance;
      app.applyViewport(390);
      expect(app.isMobile).toBeTrue();
      expect(app.mobileNavOpen).toBeFalse();
      expect(app.isSidebarCollapsed).toBeFalse();
    });

    it('defaults to a collapsed rail between md and lg', () => {
      const app = TestBed.createComponent(AppComponent).componentInstance;
      app.applyViewport(820);
      expect(app.isMobile).toBeFalse();
      expect(app.isSidebarCollapsed).toBeTrue();
    });

    it('expands the sidebar from lg up', () => {
      const app = TestBed.createComponent(AppComponent).componentInstance;
      app.applyViewport(1440);
      expect(app.isMobile).toBeFalse();
      expect(app.isSidebarCollapsed).toBeFalse();
    });

    it('toggles the drawer on mobile and the rail on desktop', () => {
      const app = TestBed.createComponent(AppComponent).componentInstance;
      app.applyViewport(390);
      app.toggleSidebar();
      expect(app.mobileNavOpen).toBeTrue();
      expect(app.isSidebarCollapsed).toBeFalse();
      app.closeMobileNav();
      expect(app.mobileNavOpen).toBeFalse();

      app.applyViewport(1440);
      app.toggleSidebar();
      expect(app.isSidebarCollapsed).toBeTrue();
      expect(app.mobileNavOpen).toBeFalse();
    });

    it('closes the drawer when the backdrop is clicked', () => {
      const fixture = TestBed.createComponent(AppComponent);
      const app = fixture.componentInstance;
      app.applyViewport(390);
      app.mobileNavOpen = true;
      fixture.detectChanges();
      const backdrop = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="sidebar-backdrop"]') as HTMLElement;
      expect(backdrop).toBeTruthy();
      backdrop.click();
      expect(app.mobileNavOpen).toBeFalse();
    });
  });
});
