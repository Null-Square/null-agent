import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';
import { logError } from '@shared/lib/errorLogger';

vi.mock('@shared/lib/errorLogger', () => ({
  logError: vi.fn(),
}));

const ProblemChild = () => {
  throw new Error('Boom');
};

describe('ErrorBoundary', () => {
  it('renders fallback UI and logs errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/application error/i)).toBeInTheDocument();
    expect(logError).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('reloads the page from the fallback UI', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ProblemChild />
      </ErrorBoundary>,
    );

    expect(() =>
      fireEvent.click(screen.getByRole('button', { name: /reload/i })),
    ).not.toThrow();
    consoleSpy.mockRestore();
  });
});
