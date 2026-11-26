import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorNotice } from '@null-ai/design-tokens/ui';
import { logError } from '@shared/lib/errorLogger';

interface DashboardErrorBoundaryProps {
  children: ReactNode;
}

interface DashboardErrorBoundaryState {
  hasError: boolean;
}

export class DashboardErrorBoundary extends Component<
  DashboardErrorBoundaryProps,
  DashboardErrorBoundaryState
> {
  state: DashboardErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    void logError({ error, source: 'dashboard', context: { componentStack: info.componentStack } });
  }

  handleReset = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      // A rounded card with a circular badge, a drop shadow and a raw
      // `amber-500` — four rules at once, on the one screen a user only ever
      // sees when something is already wrong. It is a notice now: hairlines on
      // black, a signal edge down the left, and the verb as the one yellow.
      return (
        <ErrorNotice
          icon="dashboard"
          label="Dashboard error"
          title="Something went wrong while loading the dashboard."
          description="Resetting reloads it from the last known data."
          actionLabel="Reset"
          onAction={this.handleReset}
        />
      );
    }

    return this.props.children;
  }
}
