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
  getReplayId,
  setConsent,
  stopReplay,
  PlatformRumOptions,
  PlatformTelemetryConfig,
  RumHandle,
  RumPlan,
  RumSkipReason,
  RumTransportItem,
  RumEnvironment,
} from './rum';
export type { PlatformReplayOptions, ReplayHandle, ReplayMode, ReplaySkipReason } from './rum-replay';
export type { PlatformHeatmapOptions } from './rum-heatmap';
export {
  PlatformRumService,
  RumRouterLike,
  trackRouterViews,
  isNavigationEnd,
  startPlatformRum,
  providePlatformRum,
  PlatformRumErrorHandler,
} from './rum.service';

export type { ErrorEvent, ErrorFrame } from './error-event';
