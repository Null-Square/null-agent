/* @vitest-environment jsdom */

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchApi } from '@shared/api';
import { ScopeProvider, useScope } from './ScopeContext';

vi.mock('@shared/api', () => ({
  fetchApi: {
    get: vi.fn(),
  },
}));

const mockFetchScopes = vi.mocked(fetchApi.get);

const ScopeReader = () => {
  const { scopes, isLoading } = useScope();
  return (
    <div>
      <span data-testid="scope-count">{scopes.length}</span>
      <span data-testid="scope-loading">{String(isLoading)}</span>
    </div>
  );
};

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('ScopeProvider', () => {
  beforeEach(() => {
    mockFetchScopes.mockReset();
    window.localStorage.clear();
  });

  it('does not request authenticated scopes when disabled', () => {
    const Wrapper = createWrapper();

    render(
      <Wrapper>
        <ScopeProvider enabled={false}>
          <ScopeReader />
        </ScopeProvider>
      </Wrapper>,
    );

    expect(screen.getByTestId('scope-count')).toHaveTextContent('0');
    expect(screen.getByTestId('scope-loading')).toHaveTextContent('false');
    expect(mockFetchScopes).not.toHaveBeenCalled();
  });
});
