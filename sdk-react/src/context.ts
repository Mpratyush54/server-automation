import React, { createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import axios, { AxiosInstance } from 'axios';
import { attachMetrics, createTelemetryClient, platformHeaders } from './telemetry';

export interface PlatformConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
}

export interface PlatformContextValue {
  config: PlatformConfig;
  api: AxiosInstance;
}

/** @internal Used by ErrorBoundary / BugReporterWidget to default their `config`. */
export const PlatformContext = createContext<PlatformContextValue | null>(null);

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform must be used within <PlatformProvider>');
  return ctx;
}

export interface PlatformProviderProps {
  config: PlatformConfig;
  children: ReactNode;
}

export function PlatformProvider({ config, children }: PlatformProviderProps) {
  const api = useRef(
    axios.create({
      baseURL: config.apiBase,
      headers: platformHeaders(config),
    })
  ).current;

  useEffect(() => {
    // Metrics are posted on a separate, interceptor-free client: posting them
    // through `api` would re-trigger this interceptor and loop forever.
    const telemetry = createTelemetryClient(config);
    return attachMetrics(api, telemetry, config);
  }, [api, config]);

  return React.createElement(PlatformContext.Provider, { value: { config, api } }, children);
}
