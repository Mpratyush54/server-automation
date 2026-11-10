import React, { Component, ErrorInfo, ReactNode } from 'react';
import axios from 'axios';
import { PlatformConfig, PlatformContext, PlatformContextValue } from './context';
import { platformHeaders, redactSensitive } from './telemetry';
import { reportRumError } from './rum';

export interface ErrorBoundaryProps {
  /** Defaults to the config of the enclosing `<PlatformProvider>`. */
  config?: PlatformConfig;
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static contextType = PlatformContext;
  declare context: PlatformContextValue | null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportRumError(error, { source: 'react-error-boundary' });
    this.reportBug(error, errorInfo);
  }

  private async reportBug(error: Error, errorInfo: ErrorInfo) {
    const config = this.props.config ?? this.context?.config;
    if (!config) {
      console.warn('[Platform] ErrorBoundary needs a `config` prop or an enclosing <PlatformProvider>; crash not reported.');
      return;
    }
    const message = redactSensitive(error?.message || String(error));
    try {
      await axios.post(`${config.apiBase}/api/sdk/bug-report`, {
        projectId: config.projectId,
        environment: config.environment || 'production',
        description: message,
        category: 'react-crash',
        consoleLogs: [
          { level: 'error', message, stack: redactSensitive(error?.stack || '') },
          { level: 'error', message: `Component Stack: ${errorInfo.componentStack}` },
        ],
        browserInfo: {
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
          url: typeof window !== 'undefined' ? redactSensitive(window.location.href) : '',
        },
        appState: {},
      }, {
        headers: platformHeaders(config),
      });
    } catch {
      // Silently fail — bug reporting should never crash the app
    }
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || React.createElement('div', {
        style: { padding: '20px', color: '#dc2626', fontFamily: 'monospace' }
      }, 'Something went wrong. A bug report has been submitted.');
    }
    return this.props.children;
  }
}
