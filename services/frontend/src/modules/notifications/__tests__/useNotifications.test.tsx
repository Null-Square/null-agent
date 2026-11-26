/**
 * useNotifications Hook Tests
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as notificationsApi from '../api/notifications';
import {
  useNotifications,
  useUnreadCount,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification
} from '../hooks/useNotifications';
import type { ReactNode } from 'react';

// Mock the API module
vi.mock('../api/notifications');

const mockApi = notificationsApi as unknown as {
  getNotifications: ReturnType<typeof vi.fn>;
  getUnreadCount: ReturnType<typeof vi.fn>;
  markAsRead: ReturnType<typeof vi.fn>;
  markAllAsRead: ReturnType<typeof vi.fn>;
  deleteNotification: ReturnType<typeof vi.fn>;
};

describe('Notification Hooks', () => {
  let queryClient: QueryClient;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    vi.clearAllMocks();
  });

  describe('useNotifications', () => {
    it('fetches notifications successfully', async () => {
      const mockData = {
        notifications: [
          {
            id: 'n1',
            userId: 'u1',
            type: 'system',
            title: 'Welcome',
            message: 'Hello!',
            read: false,
            createdAt: '2025-01-01T00:00:00Z',
          },
        ],
        total: 1,
        unreadCount: 1,
      };
      mockApi.getNotifications.mockResolvedValue(mockData);

      const { result } = renderHook(() => useNotifications(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.notifications).toHaveLength(1);
      expect(result.current.data?.total).toBe(1);
    });

    it('passes options to API', async () => {
      mockApi.getNotifications.mockResolvedValue({
        notifications: [],
        total: 0,
        unreadCount: 0,
      });

      renderHook(() => useNotifications({ unreadOnly: true, limit: 10 }), { wrapper });

      await waitFor(() => {
        expect(mockApi.getNotifications).toHaveBeenCalledWith({ unreadOnly: true, limit: 10 });
      });
    });
  });

  describe('useUnreadCount', () => {
    it('fetches unread count', async () => {
      mockApi.getUnreadCount.mockResolvedValue(5);

      const { result } = renderHook(() => useUnreadCount(), { wrapper });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toBe(5);
    });
  });

  describe('useMarkAsRead', () => {
    it('marks notification as read and invalidates cache', async () => {
      mockApi.markAsRead.mockResolvedValue(undefined);
      mockApi.getNotifications.mockResolvedValue({
        notifications: [],
        total: 0,
        unreadCount: 0,
      });
      mockApi.getUnreadCount.mockResolvedValue(0);

      const { result } = renderHook(() => useMarkAsRead(), { wrapper });

      result.current.mutate('n1');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.markAsRead).toHaveBeenCalled();
      expect(mockApi.markAsRead.mock.calls[0][0]).toBe('n1');
    });
  });

  describe('useMarkAllAsRead', () => {
    it('marks all as read and invalidates cache', async () => {
      mockApi.markAllAsRead.mockResolvedValue(3);
      mockApi.getNotifications.mockResolvedValue({
        notifications: [],
        total: 0,
        unreadCount: 0,
      });
      mockApi.getUnreadCount.mockResolvedValue(0);

      const { result } = renderHook(() => useMarkAllAsRead(), { wrapper });

      result.current.mutate();

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.markAllAsRead).toHaveBeenCalled();
    });
  });

  describe('useDeleteNotification', () => {
    it('deletes notification and invalidates cache', async () => {
      mockApi.deleteNotification.mockResolvedValue(undefined);
      mockApi.getNotifications.mockResolvedValue({
        notifications: [],
        total: 0,
        unreadCount: 0,
      });
      mockApi.getUnreadCount.mockResolvedValue(0);

      const { result } = renderHook(() => useDeleteNotification(), { wrapper });

      result.current.mutate('n1');

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockApi.deleteNotification).toHaveBeenCalled();
      expect(mockApi.deleteNotification.mock.calls[0][0]).toBe('n1');
    });
  });
});
