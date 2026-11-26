import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { EventEmitter } from 'events';
import request from 'supertest';
import notificationsRouter from '@/interfaces/http/controllers/notifications.router';
import { apiErrorHandler, ERROR_CODES, sendApiError } from '@/shared/errors';

const mocks = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  deleteNotification: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    if ((global as any).__NOTIFICATIONS_AUTH_FAIL__) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INVALID_SESSION,
        message: 'Authentication required',
        status: 401,
      });
    }
    req.user = { id: 'u-notify' };
    next();
  },
}));

vi.mock('@/app/services/platform/notifications/notificationAppService', () => ({
  notificationAppService: {
    getNotifications: (...args: any[]) => mocks.getNotifications(...args),
    getUnreadCount: (...args: any[]) => mocks.getUnreadCount(...args),
    markAsRead: (...args: any[]) => mocks.markAsRead(...args),
    markAllAsRead: (...args: any[]) => mocks.markAllAsRead(...args),
    deleteNotification: (...args: any[]) => mocks.deleteNotification(...args),
    subscribe: (...args: any[]) => mocks.subscribe(...args),
  },
}));

const buildApp = () => {
  const app = express();
  app.locals.isDev = true;
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use(apiErrorHandler);
  return app;
};

describe('notifications.router contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as any).__NOTIFICATIONS_AUTH_FAIL__ = false;
    mocks.subscribe.mockReturnValue(() => {});
  });

  it('returns 401 when auth middleware rejects', async () => {
    (global as any).__NOTIFICATIONS_AUTH_FAIL__ = true;
    const app = buildApp();

    const res = await request(app).get('/api/notifications');

    expect(res.status).toBe(401);
  });

  it('lists notifications with parsed query options', async () => {
    mocks.getNotifications.mockResolvedValue({ notifications: [], total: 0, unread: 0 });

    const app = buildApp();
    const res = await request(app).get('/api/notifications?unreadOnly=true&limit=101&offset=10');

    expect(res.status).toBe(200);
    expect(mocks.getNotifications).toHaveBeenCalledWith('u-notify', {
      unreadOnly: true,
      limit: 100,
      offset: 10,
    });
  });

  it('returns unread count', async () => {
    mocks.getUnreadCount.mockResolvedValue(7);

    const app = buildApp();
    const res = await request(app).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
  });

  it('marks a notification as read', async () => {
    mocks.markAsRead.mockResolvedValue(true);

    const app = buildApp();
    const res = await request(app).patch('/api/notifications/11111111-1111-1111-1111-111111111111/read');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when notification is missing during mark read', async () => {
    mocks.markAsRead.mockResolvedValue(false);

    const app = buildApp();
    const res = await request(app).patch('/api/notifications/11111111-1111-1111-1111-111111111111/read');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('marks all notifications as read', async () => {
    mocks.markAllAsRead.mockResolvedValue(4);

    const app = buildApp();
    const res = await request(app).post('/api/notifications/mark-all-read');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
  });

  it('deletes a notification', async () => {
    mocks.deleteNotification.mockResolvedValue(true);

    const app = buildApp();
    const res = await request(app).delete('/api/notifications/11111111-1111-1111-1111-111111111111');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when notification delete fails', async () => {
    mocks.deleteNotification.mockResolvedValue(false);

    const app = buildApp();
    const res = await request(app).delete('/api/notifications/11111111-1111-1111-1111-111111111111');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ERROR_CODES.RESOURCE_NOT_FOUND);
  });

  it('has no web push: the push subscription routes are gone', async () => {
    const app = buildApp();
    const key = await request(app).get('/api/notifications/push/vapid-public-key');
    const subscribe = await request(app)
      .post('/api/notifications/push/subscribe')
      .send({ endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } });

    expect(key.status).toBe(404);
    expect(subscribe.status).toBe(404);
  });

  it('streams notifications via SSE', async () => {
    const router = notificationsRouter as any;
    const layer = router.stack.find((l: any) => l.route?.path === '/stream');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle as any;

    const headers: Record<string, string> = {};
    const unsubscribe = vi.fn();
    mocks.subscribe.mockReturnValue(unsubscribe);

    const req = Object.assign(new EventEmitter(), {
      user: { id: 'u-notify' },
      on: EventEmitter.prototype.on,
      once: EventEmitter.prototype.once,
    });
    const res = Object.assign(new EventEmitter(), {
      setHeader: (key: string, value: string) => {
        headers[key.toLowerCase()] = value;
      },
      getHeader: (key: string) => headers[key.toLowerCase()],
      write: vi.fn(),
      flushHeaders: vi.fn(),
    });

    const next = vi.fn();
    await handler(req as any, res as any, next);

    expect(headers['content-type']).toContain('text/event-stream');
    const writes = (res.write as any).mock.calls.map((call: any[]) => call[0]).join('');
    expect(writes).toContain('event: connected');
    expect(mocks.subscribe).toHaveBeenCalledWith('u-notify', expect.any(Function));

    req.emit('close');
    expect(unsubscribe).toHaveBeenCalled();
  });
});
