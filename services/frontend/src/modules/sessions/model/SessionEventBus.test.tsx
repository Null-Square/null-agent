import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactElement } from 'react';
import { SessionEventBusProvider, useSessionEventBus } from './SessionEventBus';

const Consumer = ({ sessionId }: { sessionId: string }): ReactElement | null => {
  const { invalidateSessions, invalidateSession } = useSessionEventBus();
  useEffect(() => {
    invalidateSessions();
    invalidateSession(sessionId);
  }, [invalidateSession, invalidateSessions, sessionId]);
  return null;
};

describe('SessionEventBus', () => {
  it('invalidates session queries', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <SessionEventBusProvider>
          <Consumer sessionId="s1" />
        </SessionEventBusProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-sessions'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['ai-agent-session', 's1'] });
    });
  });

  it('throws when hook is used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer sessionId="s1" />)).toThrowError(
      'useSessionEventBus must be used within SessionEventBusProvider',
    );
    consoleSpy.mockRestore();
  });
});
