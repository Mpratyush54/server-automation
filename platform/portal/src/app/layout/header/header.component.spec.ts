import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HeaderComponent } from './header.component';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';
import { of } from 'rxjs';

describe('HeaderComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;
  let apiService: jasmine.SpyObj<ApiService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['getUser', 'getRole', 'login', 'setUser']);
    const apiSpy = jasmine.createSpyObj('ApiService', ['getMe', 'getNotifications', 'markNotificationRead', 'markAllNotificationsRead']);
    apiSpy.getMe.and.returnValue(of({ name: 'Test User', email: 't@t.io', role: 'developer', avatarUrl: null }));
    apiSpy.getNotifications.and.returnValue(of({ items: [], unreadCount: 0 }));

    await TestBed.configureTestingModule({
      imports: [HeaderComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: authSpy },
        { provide: ApiService, useValue: apiSpy },
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
});
