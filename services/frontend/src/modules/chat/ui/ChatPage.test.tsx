import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChatPage from './ChatPage';

vi.mock('./ChatErrorBoundary', () => ({
  ChatErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chat-boundary">{children}</div>
  ),
}));

vi.mock('./ChatRoute', () => ({
  default: () => <div data-testid="chat-route" />,
}));

describe('ChatPage', () => {
  it('wraps ChatRoute with ChatErrorBoundary', () => {
    render(<ChatPage />);

    expect(screen.getByTestId('chat-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('chat-route')).toBeInTheDocument();
  });
});
