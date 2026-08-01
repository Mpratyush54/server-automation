import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';

/**
 * Standalone Angular bootstrapApplication config.
 *
 *   bootstrapApplication(AppComponent, appConfig);
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    importProvidersFrom(
      PlatformModule.forRoot({
        apiBase: (globalThis as any).NG_APP_PLATFORM_URL || 'https://api.example.sslip.io',
        token: (globalThis as any).NG_APP_PLATFORM_SDK_TOKEN || '',
        projectId: (globalThis as any).NG_APP_PLATFORM_PROJECT_ID || '',
        environment: 'development',
        appName: 'angular-standalone-example',
      }),
    ),
  ],
};
