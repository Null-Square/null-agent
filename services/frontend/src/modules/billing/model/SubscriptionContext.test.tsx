/* @vitest-environment jsdom */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SubscriptionProvider, useSubscription } from './SubscriptionContext';
import { useSubscriptionQuery, useRefreshSubscription } from '@modules/billing/api/subscription';

vi.mock('@modules/billing/api/subscription', () => ({
  useSubscriptionQuery: vi.fn(),
  useRefreshSubscription: vi.fn(),
}));

const mockUseSubscriptionQuery = vi.mocked(useSubscriptionQuery);
const mockUseRefreshSubscription = vi.mocked(useRefreshSubscription);

const SubscriptionReader = () => {
  const { subscription, refresh } = useSubscription();
  return (
    <>
      <div data-testid="plan">{subscription?.plan.slug ?? 'none'}</div>
      <button type="button" onClick={() => void refresh()}>
        Refresh
      </button>
    </>
  );
};

describe('SubscriptionContext', () => {
  beforeEach(() => {
    mockUseSubscriptionQuery.mockReset();
    mockUseRefreshSubscription.mockReset();
  });

  it('exposes subscription data', () => {
    mockUseSubscriptionQuery.mockReturnValue({
      data: {
        plan: { id: 'local', slug: 'local', name: 'Local' },
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSubscriptionQuery>);
    mockUseRefreshSubscription.mockReturnValue(vi.fn());

    render(
      <SubscriptionProvider>
        <SubscriptionReader />
      </SubscriptionProvider>,
    );

    expect(screen.getByTestId('plan').textContent).toBe('local');
  });

  it('exposes refresh handler', () => {
    const refreshSpy = vi.fn();
    mockUseSubscriptionQuery.mockReturnValue({
      data: {
        plan: { id: 'local', slug: 'local', name: 'Local' },
      },
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSubscriptionQuery>);
    mockUseRefreshSubscription.mockReturnValue(refreshSpy);

    render(
      <SubscriptionProvider>
        <SubscriptionReader />
      </SubscriptionProvider>,
    );

    act(() => {
      screen.getByRole('button', { name: /refresh/i }).click();
    });

    expect(refreshSpy).toHaveBeenCalled();
  });

  it('does not query while the owner is not known yet, and never listens for sign-in events', () => {
    const refetchSpy = vi.fn();
    mockUseSubscriptionQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch: refetchSpy,
    } as unknown as ReturnType<typeof useSubscriptionQuery>);
    mockUseRefreshSubscription.mockReturnValue(vi.fn());

    render(
      <SubscriptionProvider enabled={false}>
        <SubscriptionReader />
      </SubscriptionProvider>,
    );

    act(() => {
      window.dispatchEvent(new Event('auth:session-changed'));
      window.dispatchEvent(new Event('subscription:changed'));
    });

    expect(mockUseSubscriptionQuery).toHaveBeenCalledWith(false);
    expect(refetchSpy).not.toHaveBeenCalled();
  });
});
