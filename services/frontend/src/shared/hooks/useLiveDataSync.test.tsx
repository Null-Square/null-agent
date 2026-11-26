import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useLiveDataSync } from './useLiveDataSync';
import { resetLiveEventStream } from '@/shared/lib/liveEventStream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  static OPEN = 1;
  readyState = MockEventSource.OPEN;
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() { this.readyState = 2; }
}

/** The keys handed to invalidateQueries, in call order. */
const invalidatedKeys = (spy: ReturnType<typeof vi.fn>): string[] =>
  spy.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey));

describe('useLiveDataSync', () => {
  let client: QueryClient;
  let invalidate: ReturnType<typeof vi.fn>;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  const emitLive = (payload: unknown) => {
    MockEventSource.instances[0].emit('live', payload);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    localStorage.clear();
    client = new QueryClient();
    invalidate = vi.fn();
    client.invalidateQueries = invalidate as unknown as QueryClient['invalidateQueries'];
  });

  afterEach(() => {
    resetLiveEventStream();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('refreshes the risk surfaces when a finding is reported', () => {
    renderHook(() => useLiveDataSync(), { wrapper });

    emitLive({ kind: 'risk.created' });
    vi.advanceTimersByTime(400);

    expect(invalidatedKeys(invalidate)).toEqual([
      '["risks"]',
      '["asset-findings"]',
      '["dashboard-summary"]',
    ]);
  });

  it('refreshes the run surfaces when a run changes state', () => {
    renderHook(() => useLiveDataSync(), { wrapper });

    emitLive({ kind: 'run.changed', runId: 'run-1' });
    vi.advanceTimersByTime(400);

    expect(invalidatedKeys(invalidate)).toEqual([
      '["runs"]',
      '["run"]',
      '["dashboard-summary"]',
    ]);
  });

  it('collapses a burst of findings into one refetch per surface', () => {
    // A single run reports findings in bursts. Without this, twenty findings
    // would mean twenty identical refetches of the same list — the request
    // storm this app has already had to fix once.
    renderHook(() => useLiveDataSync(), { wrapper });

    for (let i = 0; i < 20; i += 1) emitLive({ kind: 'risk.created' });
    vi.advanceTimersByTime(400);

    expect(invalidate).toHaveBeenCalledTimes(3);
  });

  it('does not refetch before the coalescing window closes', () => {
    renderHook(() => useLiveDataSync(), { wrapper });

    emitLive({ kind: 'risk.created' });
    vi.advanceTimersByTime(399);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ignores a kind it does not know', () => {
    // A newer server than this tab. Refreshing on the kinds it understands is
    // correct; throwing would take the whole live surface down.
    renderHook(() => useLiveDataSync(), { wrapper });

    expect(() => emitLive({ kind: 'something.new' })).not.toThrow();
    vi.advanceTimersByTime(400);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not connect when disabled', () => {
    // The demo has no session, so connecting would be a guaranteed 401.
    renderHook(() => useLiveDataSync(false), { wrapper });
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('drops a pending refetch when it unmounts', () => {
    const view = renderHook(() => useLiveDataSync(), { wrapper });

    emitLive({ kind: 'risk.created' });
    view.unmount();
    vi.advanceTimersByTime(400);

    expect(invalidate).not.toHaveBeenCalled();
  });
});
