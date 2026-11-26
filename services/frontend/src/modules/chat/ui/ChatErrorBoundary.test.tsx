/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatErrorBoundary } from './ChatErrorBoundary';
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
      throw new Error('Chat crash');
    }
  }
  render() {
    return <div>Recovered Chat</div>;
  }
}

describe('ChatErrorBoundary', () => {
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
      <ChatErrorBoundary>
        <ThrowOnMount />
      </ChatErrorBoundary>,
    );

    expect(screen.getByText(/chat module error/i)).toBeTruthy();
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'chat' }),
    );
  });

  it('resets when the reset button is clicked', () => {
    render(
      <ChatErrorBoundary>
        <ThrowOnMount />
      </ChatErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /reset chat view/i }));

    expect(screen.getByText('Recovered Chat')).toBeTruthy();
  });
});
