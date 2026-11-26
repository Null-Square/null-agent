import React from 'react';
import { ErrorNotice } from '@null-ai/design-tokens/ui';
import { logError } from '@shared/lib/errorLogger';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo });
    
    // Log the error to the database
    logError({
      error,
      source: 'ErrorBoundary',
      severity: 'critical',
      context: {
        componentStack: errorInfo.componentStack,
        url: typeof window !== 'undefined' ? window.location.href : '',
      }
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorNotice
          icon="threat"
          label="Application error"
          title="Something went wrong while rendering this page."
          description="Reloading starts the app again. Nothing you have saved is affected."
          actionLabel="Reload"
          onAction={() => window.location.reload()}
        />
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
