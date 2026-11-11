export { PlatformProvider, usePlatform, PlatformConfig, PlatformContextValue, PlatformProviderProps } from './context';
export { ErrorBoundary, ErrorBoundaryProps } from './error-boundary';
export { BugReporterWidget, BugReporterWidgetProps } from './bug-reporter';
export { redactSensitive, maskSensitiveInputs, SENSITIVE_INPUT_SELECTOR } from './telemetry';
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
export type { PlatformHeatmapOptions } from './rum-heatmap';
export { useRumPageView, RumLocationLike } from './rum-react';
export type { PlatformReplayOptions, ReplayHandle, ReplayMode, ReplaySkipReason } from './rum-replay';

export type { ErrorEvent, ErrorFrame } from './error-event';
