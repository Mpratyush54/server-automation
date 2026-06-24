import { TestBed } from '@angular/core/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { HeaderComponent } from './header.component';
import { AuthService } from '../../services/auth.service';

describe('HeaderComponent', () => {
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    const authSpy = jasmine.createSpyObj('AuthService', ['getUser', 'getRole', 'login']);

    await TestBed.configureTestingModule({
      imports: [HeaderComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authSpy },
      ],
    }).compileComponents();

    authService = TestBed.inject(AuthService) as jasmine.SpyObj<AuthService>;
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

    expect(fixture.componentInstance.currentUser).toEqual({ name: 'Test User', role: 'developer' });
    expect(fixture.componentInstance.selectedRole).toBe('developer');
  });

  it('should have role options', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    expect(fixture.componentInstance.roles.length).toBe(3);
  });

  it('should accept title input', () => {
    const fixture = TestBed.createComponent(HeaderComponent);
    fixture.componentInstance.title = 'Projects';
    expect(fixture.componentInstance.title).toBe('Projects');
  });
});
