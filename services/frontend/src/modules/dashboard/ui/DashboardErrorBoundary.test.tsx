/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DashboardErrorBoundary } from './DashboardErrorBoundary';
import { logError } from '@shared/lib/errorLogger';

vi.mock('@shared/lib/errorLogger', () => ({
  logError: vi.fn(),
}));

const mockLogError = vi.mocked(logError);

let shouldThrow = true;
let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;

class ThrowOnMount extends React.Component {
  componentDidMount() {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('Dashboard crash');
    }
  }
  render() {
    return <div>Recovered Dashboard</div>;
  }
}

describe('DashboardErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = true;
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
    consoleSpy = null;
  });

  it('renders the fallback and logs errors', () => {
    render(
      <DashboardErrorBoundary>
        <ThrowOnMount />
      </DashboardErrorBoundary>,
    );

    expect(screen.getByText(/dashboard error/i)).toBeTruthy();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'dashboard' }),
    );
  });

  it('resets when the reset button is clicked', () => {
    render(
      <DashboardErrorBoundary>
        <ThrowOnMount />
      </DashboardErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    expect(screen.getByText('Recovered Dashboard')).toBeTruthy();
  });
});
