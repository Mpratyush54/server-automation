import React, { createContext, useContext, useEffect, useRef, ReactNode } from 'react';
import axios, { AxiosInstance } from 'axios';

export interface CapsConfig {
  apiBase: string;
  token: string;
  projectId: string;
  environment?: string;
  appName?: string;
}

export interface CapsContextValue {
  config: CapsConfig;
  api: AxiosInstance;
}

const CapsContext = createContext<CapsContextValue | null>(null);

export function useCaps(): CapsContextValue {
  const ctx = useContext(CapsContext);
  if (!ctx) throw new Error('useCaps must be used within <CapsProvider>');
  return ctx;
}

export interface CapsProviderProps {
  config: CapsConfig;
  children: ReactNode;
}

export function CapsProvider({ config, children }: CapsProviderProps) {
  const api = useRef(
    axios.create({
      baseURL: config.apiBase,
      headers: { Authorization: `Bearer ${config.token}` },
    })
  ).current;

  useEffect(() => {
    api.interceptors.request.use((cfg) => {
      (cfg as any).__startTime = Date.now();
      return cfg;
    });

    api.interceptors.response.use(
      (res) => {
        const duration = Date.now() - ((res.config as any).__startTime || Date.now());
        sendMetric(api, config, {
          route: res.config.url || '',
          method: (res.config.method || 'get').toUpperCase(),
          statusCode: res.status,
          durationMs: duration,
        });
        return res;
      },
      (err) => {
        if (err.config) {
          const duration = Date.now() - ((err.config as any).__startTime || Date.now());
          sendMetric(api, config, {
            route: err.config.url || '',
            method: (err.config.method || 'get').toUpperCase(),
            statusCode: err.response?.status || 0,
            durationMs: duration,
          });
        }
        return Promise.reject(err);
      }
    );
  }, [api, config]);

  return React.createElement(CapsContext.Provider, { value: { config, api } }, children);
}

interface MetricPayload {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

function sendMetric(api: AxiosInstance, config: CapsConfig, payload: MetricPayload) {
  api.post('/api/sdk/api-metrics', {
    projectId: config.projectId,
    environment: config.environment || 'production',
    ...payload,
  }).catch(() => {});
}
