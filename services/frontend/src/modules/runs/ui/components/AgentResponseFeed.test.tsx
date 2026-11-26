import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseQuery = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

import AgentResponseFeed from './AgentResponseFeed';

describe('AgentResponseFeed polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it('polls while the selected agent can still produce messages', () => {
    render(<AgentResponseFeed sessionId="session-live" />);

    expect(mockUseQuery.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ refetchInterval: 5_000 }),
    );
  });

  it('keeps the initial read but stops polling terminal agent output', () => {
    render(<AgentResponseFeed sessionId="session-done" isTerminal />);

    expect(mockUseQuery.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        enabled: true,
        refetchInterval: false,
      }),
    );
  });
});
