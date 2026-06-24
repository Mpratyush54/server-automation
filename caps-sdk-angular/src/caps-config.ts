import { InjectionToken } from '@angular/core';

export interface CapsConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
}

export const CAPS_CONFIG = new InjectionToken<CapsConfig>('CAPS_CONFIG');
