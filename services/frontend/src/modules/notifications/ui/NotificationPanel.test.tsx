/* @vitest-environment jsdom */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NotificationPanel } from './NotificationPanel';
import {
  useNotifications,
  useMarkAsRead,
  useMarkAllAsRead,
  useDeleteNotification,
} from '../hooks/useNotifications';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../hooks/useNotifications', () => ({
  useNotifications: vi.fn(),
  useMarkAsRead: vi.fn(),
  useMarkAllAsRead: vi.fn(),
  useDeleteNotification: vi.fn(),
}));

const mockUseNotifications = vi.mocked(useNotifications);
const mockUseMarkAsRead = vi.mocked(useMarkAsRead);
const mockUseMarkAllAsRead = vi.mocked(useMarkAllAsRead);
const mockUseDeleteNotification = vi.mocked(useDeleteNotification);

describe('NotificationPanel', () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockUseNotifications.mockReset();
    mockUseMarkAsRead.mockReset();
    mockUseMarkAllAsRead.mockReset();
    mockUseDeleteNotification.mockReset();
  });

  it('renders empty state when no notifications', () => {
    mockUseNotifications.mockReturnValue({
      data: { notifications: [], unreadCount: 0 },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useNotifications>);
    mockUseMarkAsRead.mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<typeof useMarkAsRead>);
    mockUseMarkAllAsRead.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useMarkAllAsRead>);
    mockUseDeleteNotification.mockReturnValue({ mutate: vi.fn() } as unknown as ReturnType<typeof useDeleteNotification>);

    render(
      <MemoryRouter>
        <NotificationPanel onClose={vi.fn()} />
      </MemoryRouter>,
    );

    // The empty state says what is true in plain words rather than shouting
    // "SYSTEM CLEAR" in mono.
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
    expect(screen.getByText(/caught up on this organization/i)).toBeTruthy();
  });

  it('marks a notification as read and navigates on click', () => {
    const markAsRead = vi.fn();
    const markAllAsRead = vi.fn();
    const deleteNotification = vi.fn();
    const onClose = vi.fn();
    const createdAt = new Date().toISOString();

    mockUseNotifications.mockReturnValue({
      data: {
        notifications: [
          {
            id: 'n1',
            type: 'action_required',
            title: 'Task Complete',
            message: 'Your task finished.',
            createdAt,
            read: false,
            link: '/session/s1',
            data: {
              runId: 'run-1',
              sessionId: 's1',
            },
          },
        ],
        unreadCount: 1,
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useNotifications>);
    mockUseMarkAsRead.mockReturnValue({ mutate: markAsRead } as unknown as ReturnType<typeof useMarkAsRead>);
    mockUseMarkAllAsRead.mockReturnValue({ mutate: markAllAsRead, isPending: false } as unknown as ReturnType<typeof useMarkAllAsRead>);
    mockUseDeleteNotification.mockReturnValue({ mutate: deleteNotification } as unknown as ReturnType<typeof useDeleteNotification>);

    render(
      <MemoryRouter>
        <NotificationPanel onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Task Complete'));

    expect(markAsRead).toHaveBeenCalledWith('n1');
    expect(mockNavigate).toHaveBeenCalledWith('/runs/run-1/workbench?session=s1');
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Clear All/i }));
    expect(markAllAsRead).toHaveBeenCalled();
  });

  it('deletes notification without navigating', () => {
    const markAsRead = vi.fn();
    const deleteNotification = vi.fn();
    const createdAt = new Date().toISOString();

    mockUseNotifications.mockReturnValue({
      data: {
        notifications: [
          {
            id: 'n2',
            type: 'system',
            title: 'System Alert',
            message: 'System message.',
            createdAt,
            read: true,
          },
        ],
        unreadCount: 0,
        total: 1,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof useNotifications>);
    mockUseMarkAsRead.mockReturnValue({ mutate: markAsRead } as unknown as ReturnType<typeof useMarkAsRead>);
    mockUseMarkAllAsRead.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<typeof useMarkAllAsRead>);
    mockUseDeleteNotification.mockReturnValue({ mutate: deleteNotification } as unknown as ReturnType<typeof useDeleteNotification>);

    render(
      <MemoryRouter>
        <NotificationPanel onClose={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(deleteNotification).toHaveBeenCalledWith('n2');
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
