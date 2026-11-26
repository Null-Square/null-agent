import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { logError } from '@shared/lib/errorLogger';

interface ChatErrorBoundaryProps {
  children: ReactNode;
}

interface ChatErrorBoundaryState {
  hasError: boolean;
}

export class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  state: ChatErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void logError({ error, source: 'chat', context: { componentStack: info.componentStack } });
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-6 font-sans">
          <div className="w-full max-w-md rounded-none border border-border bg-card p-8 text-center ">
            <div className="mb-6 inline-flex items-center justify-center">
              <span className="inline-flex h-14 w-14 items-center justify-center rounded-none bg-warning/10">
                <AlertTriangle className="h-7 w-7 text-warning" />
              </span>
            </div>
            <h1 className="mb-1.5 text-2xl font-semibold tracking-tight text-foreground">Chat module error</h1>
            <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">
              Something went wrong while rendering chat. Try resetting the view.
            </p>
            <button
              type="button"
              onClick={this.handleReset}
              className="mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-none bg-primary px-6 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <RefreshCw className="h-4 w-4" />
              Reset chat view
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
