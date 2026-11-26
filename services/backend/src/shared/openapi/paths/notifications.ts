/**
 * Notifications API path documentation
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema, SuccessResponseSchema } from '../schemas';

const NotificationTypeSchema = z.enum([
    'task_completed',
    'action_required',
    'credits_low',
    'session_error',
    'system',
]);

const NotificationSchema = z.object({
    id: z.string().uuid(),
    userId: z.string().uuid(),
    type: NotificationTypeSchema,
    title: z.string(),
    message: z.string(),
    link: z.string().nullable().optional(),
    data: z.record(z.unknown()).optional(),
    read: z.boolean(),
    createdAt: z.string(),
});

// ============================================================================
// GET /api/notifications - List notifications
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/notifications',
    tags: ['Notifications'],
    summary: 'List notifications for current user',
    request: {
        query: z.object({
            unreadOnly: z.string().optional(),
            limit: z.string().optional(),
            offset: z.string().optional(),
        }),
    },
    responses: {
        200: {
            description: 'Notification list',
            content: {
                'application/json': {
                    schema: z.object({
                        notifications: z.array(NotificationSchema),
                        total: z.number(),
                        unreadCount: z.number(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /api/notifications/unread-count - Unread count
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/notifications/unread-count',
    tags: ['Notifications'],
    summary: 'Get unread notification count',
    responses: {
        200: {
            description: 'Unread count',
            content: {
                'application/json': {
                    schema: z.object({ count: z.number() }),
                },
            },
        },
    },
});

// ============================================================================
// PATCH /api/notifications/{id}/read - Mark notification as read
// ============================================================================

registry.registerPath({
    method: 'patch',
    path: '/api/notifications/{id}/read',
    tags: ['Notifications'],
    summary: 'Mark notification as read',
    request: {
        params: z.object({ id: z.string().uuid() }),
    },
    responses: {
        200: {
            description: 'Notification marked as read',
            content: { 'application/json': { schema: SuccessResponseSchema } },
        },
        404: {
            description: 'Notification not found',
            content: { 'application/json': { schema: ErrorResponseSchema } },
        },
    },
});

// ============================================================================
// POST /api/notifications/mark-all-read - Mark all as read
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/notifications/mark-all-read',
    tags: ['Notifications'],
    summary: 'Mark all notifications as read',
    responses: {
        200: {
            description: 'Notifications marked as read',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                        count: z.number(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// DELETE /api/notifications/{id} - Delete notification
// ============================================================================

registry.registerPath({
    method: 'delete',
    path: '/api/notifications/{id}',
    tags: ['Notifications'],
    summary: 'Delete notification',
    request: {
        params: z.object({ id: z.string().uuid() }),
    },
    responses: {
        200: {
            description: 'Notification deleted',
            content: { 'application/json': { schema: SuccessResponseSchema } },
        },
        404: {
            description: 'Notification not found',
            content: { 'application/json': { schema: ErrorResponseSchema } },
        },
    },
});
