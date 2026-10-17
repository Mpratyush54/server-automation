import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  DefaultUrlSerializer,
  NavigationEnd,
  Router,
  RouterStateSnapshot,
} from '@angular/router';
import { Subject } from 'rxjs';
import { AppComponent } from '../app.component';
import { AuthService } from '../services/auth.service';
import { homeGuard, legacyLandingGuard } from './home.guard';

describe('canonical public homepage', () => {
  let host: { location: { hostname: string } };
  let authenticated: jasmine.Spy;
  let createUrlTree: jasmine.Spy;

  beforeEach(() => {
    host = { location: { hostname: 'platform.pratyushes.dev' } };
    authenticated = jasmine.createSpy().and.returnValue(false);
    createUrlTree = jasmine
      .createSpy()
      .and.returnValue(new DefaultUrlSerializer().parse('/target'));
    TestBed.configureTestingModule({
      providers: [
        { provide: DOCUMENT, useValue: host },
        { provide: Router, useValue: { createUrlTree } },
        { provide: AuthService, useValue: { isAuthenticated: authenticated } },
      ],
    });
  });
  it('renders the public homepage without redirecting to /landing', () => {
    const result = TestBed.runInInjectionContext(() =>
      homeGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
    expect(result).toBeTrue();
    expect(createUrlTree).not.toHaveBeenCalled();
    expect(authenticated).not.toHaveBeenCalled();
  });
  it('retains login and dashboard destinations on self-hosted portals', () => {
    host.location.hostname = 'portal.example.org';
    TestBed.runInInjectionContext(() =>
      homeGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
    expect(createUrlTree).toHaveBeenCalledWith(['/login']);
    authenticated.and.returnValue(true);
    TestBed.runInInjectionContext(() =>
      homeGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
    expect(createUrlTree).toHaveBeenCalledWith(['/dashboard']);
  });
  it('keeps query parameters and section fragments on legacy links', () => {
    const route = {
      queryParams: { campaign: 'launch' },
      fragment: 'watch',
    } as unknown as ActivatedRouteSnapshot;
    TestBed.runInInjectionContext(() =>
      legacyLandingGuard(route, {} as RouterStateSnapshot),
    );
    expect(createUrlTree).toHaveBeenCalledWith(['/'], {
      queryParams: { campaign: 'launch' },
      fragment: 'watch',
    });
  });
  it('keeps the homepage full-screen even when it has a query or fragment', () => {
    const events = new Subject<NavigationEnd>();
    const router = { events, url: '/?campaign=launch#watch' };
    const app = new AppComponent(router as unknown as Router);
    events.next(new NavigationEnd(1, router.url, router.url));
    expect(app.isLandingPage).toBeTrue();
    expect(app.isDocsPage).toBeFalse();
    router.url = '/docs#installation';
    events.next(new NavigationEnd(2, router.url, router.url));
    expect(app.isDocsPage).toBeTrue();
    expect(app.isLandingPage).toBeFalse();
    events.complete();
  });
});
