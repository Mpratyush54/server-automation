import React, { Component, ErrorInfo, ReactNode } from 'react';
import axios from 'axios';
import { CapsConfig } from './context';

export interface ErrorBoundaryProps {
  config: CapsConfig;
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.reportBug(error, errorInfo);
  }

  private async reportBug(error: Error, errorInfo: ErrorInfo) {
    try {
      await axios.post(`${this.props.config.apiBase}/api/sdk/bug-report`, {
        projectId: this.props.config.projectId,
        environment: this.props.config.environment || 'production',
        description: error.message,
        category: 'react-crash',
        consoleLogs: [
          { level: 'error', message: error.message, stack: error.stack },
          { level: 'error', message: `Component Stack: ${errorInfo.componentStack}` },
        ],
        browserInfo: {
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
          url: typeof window !== 'undefined' ? window.location.href : '',
        },
        appState: {},
      }, {
        headers: { Authorization: `Bearer ${this.props.config.token}` },
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
