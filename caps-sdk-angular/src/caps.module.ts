import { NgModule, Provider } from '@angular/core';
import { HTTP_INTERCEPTORS, ErrorHandler } from '@angular/common/http';
import { CAPS_CONFIG, CapsConfig } from './caps-config';
import { CapsHttpInterceptor } from './http-interceptor';
import { CapsErrorHandler } from './error-handler';
import { BugReporterComponent } from './bug-reporter.component';

@NgModule({
  declarations: [],
  imports: [BugReporterComponent],
  exports: [BugReporterComponent],
})
export class CapsModule {
  static forRoot(config: CapsConfig): { ngModule: typeof CapsModule; providers: Provider[] } {
    return {
      ngModule: CapsModule,
      providers: [
        { provide: CAPS_CONFIG, useValue: config },
        { provide: HTTP_INTERCEPTORS, useClass: CapsHttpInterceptor, multi: true },
        { provide: ErrorHandler, useClass: CapsErrorHandler },
      ],
    };
  }
}

export { CapsHttpInterceptor } from './http-interceptor';
export { CapsErrorHandler } from './error-handler';
export { BugReporterComponent } from './bug-reporter.component';
export { CAPS_CONFIG, CapsConfig } from './caps-config';
