/**
 * Core Web Vitals (LCP, INP, CLS, TTFB, FCP) as Faro `web-vitals` measurements, using
 * the standard `web-vitals` build (Faro's own instrumentation uses the attribution
 * build, ~4 KB gzip more, whose extra fields can carry URLs/DOM ids anyway).
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import { BaseInstrumentation, VERSION } from '@grafana/faro-core';
import { onCLS, onFCP, onINP, onLCP, onTTFB } from 'web-vitals';

export interface VitalMetric {
  name: string;
  value: number;
  delta: number;
  id: string;
  rating?: string;
  navigationType?: string;
}

/** Faro measurement payload for one web-vitals metric. */
export function vitalMeasurement(metric: VitalMetric, viewId?: string) {
  const context: Record<string, string> = { id: metric.id };
  if (metric.rating) context.rating = metric.rating;
  if (metric.navigationType) context.navigation_type = metric.navigationType;
  if (viewId) context.view_id = viewId;
  return {
    measurement: { type: 'web-vitals', values: { [metric.name.toLowerCase()]: metric.value, delta: metric.delta } },
    options: { context },
  };
}

export class PlatformWebVitalsInstrumentation extends BaseInstrumentation {
  readonly name = 'platform-rum-web-vitals';
  readonly version = VERSION;

  constructor(private readonly viewId: () => string) {
    super();
  }

  initialize(): void {
    const report = (metric: VitalMetric) => {
      const { measurement, options } = vitalMeasurement(metric, this.viewId());
      this.api.pushMeasurement(measurement, options);
    };
    onLCP(report);
    onINP(report);
    onCLS(report);
    onTTFB(report);
    onFCP(report);
  }
}
