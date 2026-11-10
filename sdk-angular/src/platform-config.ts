import { InjectionToken } from '@angular/core';
import type { PlatformRumOptions } from './rum';

export interface PlatformConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
  /**
   * Frontend RUM (web vitals, errors, resources, clicks, routes, trace propagation)
   * via Grafana Faro. Off when omitted: nothing is loaded. See `PlatformRumOptions`.
   */
  rum?: PlatformRumOptions | false;
}

export const PLATFORM_CONFIG = new InjectionToken<PlatformConfig>('PLATFORM_CONFIG');
