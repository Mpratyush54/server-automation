export { PlatformModule } from './platform.module';
export { PlatformHttpInterceptor } from './http-interceptor';
export { PlatformErrorHandler } from './error-handler';
export { BugReporterComponent } from './bug-reporter.component';
export { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
export {
  platformHeaders,
  isPlatformSdkUrl,
  redactSensitive,
  maskSensitiveInputs,
  SENSITIVE_INPUT_SELECTOR,
} from './platform-http';
export {
  initRum,
  setRumView,
  getRum,
  stopRum,
  reportRumError,
  planRum,
  shouldPropagate,
  normalizeRouteName,
  sanitizeUrl,
  scrubText,
  scrubTransportItem,
  isDoNotTrack,
  decideSampled,
  PlatformRumOptions,
  PlatformTelemetryConfig,
  RumHandle,
  RumPlan,
  RumSkipReason,
  RumTransportItem,
  RumEnvironment,
} from './rum';
export {
  PlatformRumService,
  RumRouterLike,
  trackRouterViews,
  isNavigationEnd,
  startPlatformRum,
  providePlatformRum,
  PlatformRumErrorHandler,
} from './rum.service';
