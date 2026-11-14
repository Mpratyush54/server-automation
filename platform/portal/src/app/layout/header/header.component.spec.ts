import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HeaderComponent } from './header.component';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';
import { SearchService } from '../../services/search.service';
import { signal } from '@angular/core';

describe('HeaderComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;
  let apiService: jasmine.SpyObj<ApiService>;
  let searchStub: { isOpen: ReturnType<typeof signal<boolean>>; open: jasmine.Spy; close: jasmine.Spy; search: jasmine.Spy };

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['getUser', 'getRole', 'login', 'setUser']);
    const apiSpy = jasmine.createSpyObj('ApiService', ['getMe', 'getNotifications', 'markNotificationRead', 'markAllNotificationsRead']);
    apiSpy.getMe.and.returnValue(of({ name: 'Test User', email: 't@t.io', role: 'developer', avatarUrl: null }));
    apiSpy.getNotifications.and.returnValue(of({ items: [], unreadCount: 0 }));

    searchStub = {
      isOpen: signal(false),
      open: jasmine.createSpy('open').and.callFake(() => searchStub.isOpen.set(true)),
      close: jasmine.createSpy('close').and.callFake(() => searchStub.isOpen.set(false)),
      search: jasmine.createSpy('search').and.returnValue([]),
    };

    await TestBed.configureTestingModule({
      imports: [HeaderComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: authSpy },
        { provide: ApiService, useValue: apiSpy },
        { provide: SearchService, useValue: searchStub },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
    apiService = TestBed.inject(ApiService) as jasmine.SpyObj<ApiService>;
    authService.getUser.and.returnValue({ name: 'Test User', role: 'developer' });
    authService.getRole.and.returnValue('developer');
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should have default title', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    expect(fixture.componentInstance.title).toBe('Dashboard');
  });

  it('should load current user on init', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.currentUser).toBeTruthy();
    expect(fixture.componentInstance.initials).toBe('TU');
  });

  it('should load notifications', async () => {
    apiService.getNotifications.and.returnValue(of({
      items: [{ id: 'n1', title: 'Hi', body: 'There', readAt: null }],
      unreadCount: 1,
    }));
    const fixture = TestBed.createComponent(HeaderComponent);
    await fixture.componentInstance.loadNotifications();
    expect(fixture.componentInstance.unreadCount).toBe(1);
    expect(fixture.componentInstance.notifications.length).toBe(1);
  });

  it('should accept title input', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.componentInstance.title = 'Projects';
    expect(fixture.componentInstance.title).toBe('Projects');
  });

  it('shows a menu button only on mobile and emits toggleSidebar', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="nav-menu-button"]')).toBeNull();

    fixture.componentRef.setInput('isMobile', true);
    fixture.detectChanges();
    const btn = el.querySelector('[data-testid="nav-menu-button"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    const spy = jasmine.createSpy('toggle');
    fixture.componentInstance.toggleSidebar.subscribe(spy);
    btn.click();
    expect(spy).toHaveBeenCalled();
  });

  it('shows a search field with a shortcut hint on desktop and an icon button on mobile', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const field = el.querySelector('[data-testid="search-field"]') as HTMLButtonElement;
    expect(field.textContent).toContain('Search');
    expect(field.textContent).toMatch(/Ctrl K|⌘K/);
    expect(el.querySelector('[data-testid="search-button"]')).toBeNull();
    field.click();
    expect(searchStub.open).toHaveBeenCalled();

    fixture.componentRef.setInput('isMobile', true);
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="search-field"]')).toBeNull();
    expect(el.querySelector('[data-testid="search-button"]')!.getAttribute('aria-label')).toBe('Search');
  });

  it('opens the palette with Ctrl+K, Cmd+K and "/" outside text fields', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.detectChanges();
    const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    document.dispatchEvent(ctrlK);
    expect(ctrlK.defaultPrevented).toBeTrue();
    expect(searchStub.isOpen()).toBeTrue();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('app-search-palette')).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    expect(searchStub.isOpen()).toBeFalse();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true }));
    expect(searchStub.isOpen()).toBeTrue();
    searchStub.close();

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(searchStub.isOpen()).toBeTrue();
    searchStub.close();
  });

  it('ignores "/" while typing in a field', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.detectChanges();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(searchStub.open).not.toHaveBeenCalled();
    input.remove();
  });
});
