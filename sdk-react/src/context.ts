import React, { createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import axios, { AxiosInstance } from 'axios';
import { attachMetrics, createTelemetryClient, platformHeaders } from './telemetry';
import { initRum, PlatformRumOptions } from './rum';

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

  useEffect(() => {
    // Starts once per page; a no-op (no Faro download) unless `rum` is configured and enabled.
    if (config.rum) void initRum(config.rum, { appName: config.appName, environment: config.environment });
  }, [config.rum, config.appName, config.environment]);

  return React.createElement(PlatformContext.Provider, { value: { config, api } }, children);
}
