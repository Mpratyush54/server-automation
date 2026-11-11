import { APP_INITIALIZER, ErrorHandler, Inject, Injectable, OnDestroy, Optional, Provider } from '@angular/core';
import type { Observable, Subscription } from 'rxjs';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
import { getRum, initRum, normalizeRouteName, PlatformRumOptions, reportRumError, RumHandle, setRumView } from './rum';

/** Structural type for Angular's `Router` (so the SDK does not depend on @angular/router). */
export interface RumRouterLike {
  events: Observable<unknown>;
}

/** `EventType.NavigationEnd` from @angular/router (stable since Angular 15). */
const NAVIGATION_END = 1;

/** True for an Angular Router `NavigationEnd` event. */
export function isNavigationEnd(event: any): event is { urlAfterRedirects: string } {
  return !!event && event.type === NAVIGATION_END && typeof event.urlAfterRedirects === 'string';
}

/**
 * Record a RUM view for every Router `NavigationEnd` (`/users/42` -> `/users/:id`).
 * Pass `nameFor` to derive names yourself (e.g. from the activated route config).
 */
export function trackRouterViews(router: RumRouterLike, nameFor: (url: string) => string = normalizeRouteName): Subscription {
  return router.events.subscribe((event) => {
    if (isNavigationEnd(event)) setRumView(nameFor(event.urlAfterRedirects));
  });
}

/**
 * Angular facade over the RUM runtime. `PlatformModule.forRoot({ ..., rum })` starts it
 * at bootstrap (non-blocking); call `trackRouter(router)` once, e.g. in AppComponent:
 *
 *   constructor(router: Router, rum: PlatformRumService) { rum.trackRouter(router); }
 */
@Injectable({ providedIn: 'root' })
export class PlatformRumService implements OnDestroy {
  private subscription: Subscription | null = null;

  constructor(@Optional() @Inject(PLATFORM_CONFIG) private config: PlatformConfig | null) {}

  /** Start RUM from `PlatformConfig.rum`; resolves null (and loads nothing) when off. */
  start(): Promise<RumHandle | null> {
    const cfg = this.config;
    if (!cfg || !cfg.rum) return Promise.resolve(null);
    return initRum(cfg.rum, { appName: cfg.appName, environment: cfg.environment, apiBase: cfg.apiBase, token: cfg.token });
  }

  trackRouter(router: RumRouterLike, nameFor?: (url: string) => string): void {
    this.subscription?.unsubscribe();
    this.subscription = trackRouterViews(router, nameFor);
  }

  setView(name: string): void {
    setRumView(name);
  }

  get handle(): RumHandle | null {
    return getRum();
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }
}

/** APP_INITIALIZER factory used by `PlatformModule.forRoot`: never blocks bootstrap. */
export function startPlatformRum(rum: PlatformRumService): () => void {
  return () => {
    void rum.start();
  };
}

/**
 * Angular `ErrorHandler` that forwards errors to RUM (Angular catches errors inside its zone,
 * so they never reach `window.onerror`) and then logs them like the default handler.
 * `PlatformErrorHandler` (installed by `forRoot`) already does this.
 */
@Injectable()
export class PlatformRumErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    reportRumError(error, { source: 'angular-error-handler' });
    super.handleError(error);
  }
}

/**
 * RUM without `PlatformModule.forRoot` (e.g. a standalone app that does not want the
 * metrics interceptor): `bootstrapApplication(App, { providers: [providePlatformRum({...})] })`.
 * Also installs `PlatformRumErrorHandler` unless `{ errorHandler: false }` (use that when the
 * app has its own ErrorHandler; call `reportRumError(err)` from it instead).
 */
export function providePlatformRum(
  rum: PlatformRumOptions | false | null | undefined,
  defaults: { appName?: string; environment?: string; apiBase?: string; token?: string } = {},
  options: { errorHandler?: boolean } = {},
): Provider[] {
  const providers: Provider[] = [
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => () => {
        void initRum(rum, defaults);
      },
    },
  ];
  if (options.errorHandler !== false) providers.push({ provide: ErrorHandler, useClass: PlatformRumErrorHandler });
  return providers;
}
