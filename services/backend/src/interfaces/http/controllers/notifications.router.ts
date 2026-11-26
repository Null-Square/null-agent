/**
 * Notification API Routes
 * 
 * Endpoints for managing user notifications.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { z } from 'zod';
import { SSE_NOTIFICATIONS_KEEPALIVE_MS } from '@/config/timeouts';
import { AppError } from '@/shared/errors';
import { liveEventBus, orgTopic } from '@/app/adapters/events/liveEventBus';
import { resolvePrimaryOrganizationMembership } from '@/shared/auth/resolveOrgMembership';
import { ERROR_CODES } from '@null-ai/contracts';

export const createNotificationsRouter = (kernel: PlatformKernel = createPlatformKernel()): Router => {
  const router = Router();

  // All routes require authentication
  router.use(authMiddleware);

  // Helper to get user ID from authenticated request
  const getUserId = (req: Request): string => (req as unknown as { user: { id: string } }).user.id;

/**
 * GET /api/notifications
 * List notifications for the authenticated user
 */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const unreadOnly = req.query.unreadOnly === 'true';
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await kernel.notifications.getNotifications(userId, {
        unreadOnly,
        limit,
        offset,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  });

/**
 * GET /api/notifications/unread-count
 * Get unread count for badge
 */
  router.get('/unread-count', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const count = await kernel.notifications.getUnreadCount(userId);
      res.json({ count });
    } catch (error) {
      next(error);
    }
  });

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read
 */
  const markReadSchema = z.object({
    id: z.string().uuid(),
  });

  router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = markReadSchema.parse(req.params);
      const userId = getUserId(req);

      const success = await kernel.notifications.markAsRead(id, userId);
      if (!success) {
        return next(new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Notification not found', {
          context: { notificationId: id },
        }));
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

/**
 * POST /api/notifications/mark-all-read
 * Mark all notifications as read
 */
  router.post('/mark-all-read', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = getUserId(req);
      const count = await kernel.notifications.markAllAsRead(userId);
      res.json({ success: true, count });
    } catch (error) {
      next(error);
    }
  });

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = markReadSchema.parse(req.params);
      const userId = getUserId(req);

      const success = await kernel.notifications.deleteNotification(id, userId);
      if (!success) {
        return next(new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Notification not found', {
          context: { notificationId: id },
        }));
      }

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  });

/**
 * GET /api/notifications/stream
 * Server-Sent Events endpoint for real-time notifications
 * 
 * The client should establish a connection and listen for events:
 * - 'notification': New notification received
 * - 'live': something changed for this org; the client refetches
 * - 'heartbeat': Keep-alive ping every 30 seconds
 */
  router.get('/stream', async (req: Request, res: Response) => {
    const userId = getUserId(req);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ userId })}\n\n`);

    // Subscribe to notifications for this user
    const unsubscribe = kernel.notifications.subscribe(userId, (notification) => {
      res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
    });

    /*
     * The same socket also carries 'live' events: coarse "this changed"
     * signals for the user's organization, which the browser answers by
     * refetching through the ordinary API. One connection rather than two —
     * a second EventSource would double the idle socket count per tab and
     * carry nothing this one cannot.
     *
     * Org membership is resolved best-effort on purpose. A user with no
     * organization still has notifications worth streaming, and failing the
     * whole connection to deny them live updates for lists they have no rows
     * in would be a strictly worse trade.
     */
    let unsubscribeLive: (() => void) | undefined;
    try {
      const membership = await resolvePrimaryOrganizationMembership(userId);
      unsubscribeLive = liveEventBus.subscribe(orgTopic(membership.organizationId), (event) => {
        res.write(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
      });
    } catch {
      // No organization resolved — notifications only.
    }

    // Heartbeat to keep connection alive
    const heartbeatInterval = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, SSE_NOTIFICATIONS_KEEPALIVE_MS);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      unsubscribe();
      unsubscribeLive?.();
    });
  });

  return router;
};

export default createNotificationsRouter();
