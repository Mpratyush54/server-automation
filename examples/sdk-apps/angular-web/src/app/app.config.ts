import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { providePlatformRum } from '@mpratyush54/sdk-angular';
import { API_BASE } from './api-base';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(),
    // Frontend RUM only: this demo keeps the SDK token on the backend, so it skips the metrics
    // interceptor. With the full SDK the same option is `PlatformModule.forRoot({ ..., rum })`.
    // /rum-config.json holds the telemetry block (written at container start from RUM_* env);
    // when it is missing or disabled, Faro is never downloaded.
    // It also installs PlatformRumErrorHandler so errors Angular catches reach RUM.
    providePlatformRum(
      {
        telemetryUrl: '/rum-config.json',
        // traceparent goes to this app and the demo Node API only.
        propagateTo: [window.location.origin, ...(API_BASE ? [new URL(API_BASE, window.location.href).origin] : [])],
      },
      { appName: 'sdk-angular-web', environment: 'development' },
    ),
  ],
};
