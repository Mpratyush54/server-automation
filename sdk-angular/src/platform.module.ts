import { APP_INITIALIZER, NgModule, Provider, ErrorHandler } from '@angular/core';
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
import { PlatformHttpInterceptor } from './http-interceptor';
import { PlatformErrorHandler } from './error-handler';
import { BugReporterComponent } from './bug-reporter.component';
import { PlatformRumService, startPlatformRum } from './rum.service';

@NgModule({
  declarations: [],
  imports: [BugReporterComponent],
  exports: [BugReporterComponent],
})
export class PlatformModule {
  static forRoot(config: PlatformConfig): { ngModule: typeof PlatformModule; providers: Provider[] } {
    return {
      ngModule: PlatformModule,
      providers: [
        { provide: PLATFORM_CONFIG, useValue: config },
        { provide: HTTP_INTERCEPTORS, useClass: PlatformHttpInterceptor, multi: true },
        { provide: ErrorHandler, useClass: PlatformErrorHandler },
        // Starts RUM only when `config.rum` is set and enabled; otherwise a no-op that loads nothing.
        { provide: APP_INITIALIZER, useFactory: startPlatformRum, deps: [PlatformRumService], multi: true },
      ],
    };
  }
}

export { PlatformHttpInterceptor } from './http-interceptor';
export { PlatformErrorHandler } from './error-handler';
export { BugReporterComponent } from './bug-reporter.component';
export { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
