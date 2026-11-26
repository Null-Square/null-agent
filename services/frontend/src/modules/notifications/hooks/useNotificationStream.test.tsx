import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNotificationStream } from './useNotificationStream';
import { notificationKeys } from './useNotifications';
import type { Notification, NotificationListResult } from '../api/notifications';
import { resetLiveEventStream } from '@/shared/lib/liveEventStream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  static OPEN = 1;
  url: string;
  readyState = MockEventSource.OPEN;
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent<string>;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  close() {
    this.readyState = 2;
  }
}

describe('useNotificationStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    localStorage.clear();
  });

  afterEach(() => {
    // The socket is shared and outlives any component, so a test that leaves
    // it open would hand its connection to the next one.
    resetLiveEventStream();
    vi.unstubAllGlobals();
  });

  const createWrapper = (client: QueryClient) => {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

  it('connects with no sign-in token: the local owner is always there', () => {
    localStorage.clear();
    const queryClient = new QueryClient();
    renderHook(() => useNotificationStream(), { wrapper: createWrapper(queryClient) });
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('connects and updates caches on notification events', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<NotificationListResult>(notificationKeys.list(), {
      notifications: [],
      total: 0,
      unreadCount: 0,
    });
    queryClient.setQueryData(notificationKeys.unreadCount(), 0);

    const onNotification = vi.fn();
    renderHook(() => useNotificationStream({ onNotification }), {
      wrapper: createWrapper(queryClient),
    });

    expect(MockEventSource.instances).toHaveLength(1);
    const source = MockEventSource.instances[0];

    const notification: Notification = {
      id: 'n1',
      userId: 'u1',
      type: 'system',
      title: 'Hello',
      message: 'World',
      read: false,
      createdAt: '2025-01-01T00:00:00Z',
    };
    source.emit('notification', notification);

    const updated = queryClient.getQueryData<NotificationListResult>(notificationKeys.list());
    expect(updated?.notifications).toHaveLength(1);
    expect(updated?.total).toBe(1);
    expect(updated?.unreadCount).toBe(1);
    expect(queryClient.getQueryData<number>(notificationKeys.unreadCount())).toBe(1);
    expect(onNotification).toHaveBeenCalledWith(notification);
  });

  it('skips connecting when disabled', () => {
    const queryClient = new QueryClient();
    renderHook(() => useNotificationStream({ enabled: false }), {
      wrapper: createWrapper(queryClient),
    });
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
