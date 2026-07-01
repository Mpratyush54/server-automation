import { InjectionToken } from '@angular/core';

export interface PlatformConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
}

export const PLATFORM_CONFIG = new InjectionToken<PlatformConfig>('PLATFORM_CONFIG');
