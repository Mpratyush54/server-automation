import { NgModule, Provider, ErrorHandler } from '@angular/core';
import { HTTP_INTERCEPTORS } from '@angular/common/http';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
import { PlatformHttpInterceptor } from './http-interceptor';
import { PlatformErrorHandler } from './error-handler';
import { BugReporterComponent } from './bug-reporter.component';

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
      ],
    };
  }
}

export { PlatformHttpInterceptor } from './http-interceptor';
export { PlatformErrorHandler } from './error-handler';
export { BugReporterComponent } from './bug-reporter.component';
export { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
