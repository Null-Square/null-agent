/**
 * Approvals API path documentation
 */

import { registry, z } from '../registry';
import { SessionIdParamSchema, ErrorResponseSchema } from '../schemas';

// ============================================================================
// Approval Schema
// ============================================================================

const ApprovalPreviewSchema = z.object({
    cmd: z.string().optional().openapi({ example: 'rm -rf /tmp/cache' }),
    path: z.string().optional().openapi({ example: '/src/main.ts' }),
    diff: z.string().optional(),
    risk: z.array(z.string()).optional(),
});

const ApprovalRequestSchema = z.object({
    actionId: z.string(),
    tool: z.string().openapi({ example: 'shell_command' }),
    toolCallId: z.string().optional(),
    args: z.record(z.unknown()).optional(),
    preview: ApprovalPreviewSchema.optional(),
    expiresAt: z.string().optional(),
    requestedAt: z.number().optional(),
    reason: z.string().optional(),
});

// ============================================================================
// GET /sessions/:sessionId/approvals - Get pending approval
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions/{sessionId}/approvals',
    tags: ['Approvals'],
    summary: 'Get pending approval',
    description: 'Returns the current pending approval request for a session, if any.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'Pending approval details',
            content: {
                'application/json': {
                    schema: z.object({
                        approval: ApprovalRequestSchema.nullable(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// POST /sessions/:sessionId/approve - Grant approval
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/ai-agent/sessions/{sessionId}/approve',
    tags: ['Approvals'],
    summary: 'Grant approval',
    description: 'Approves the pending tool execution request.',
    request: {
        params: SessionIdParamSchema,
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        actionId: z.string().openapi({
                            example: 'action_abc123',
                            description: 'ID of the action to approve',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'Approval granted',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                    }),
                },
            },
        },
        400: {
            description: 'No pending approval or action ID mismatch',
            content: {
                'application/json': { schema: ErrorResponseSchema },
            },
        },
    },
});

// ============================================================================
// POST /sessions/:sessionId/deny - Deny approval
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/ai-agent/sessions/{sessionId}/deny',
    tags: ['Approvals'],
    summary: 'Deny approval',
    description: 'Denies the pending tool execution request.',
    request: {
        params: SessionIdParamSchema,
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        actionId: z.string(),
                        reason: z.string().optional().openapi({
                            example: 'Too risky',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'Approval denied',
            content: {
                'application/json': {
                    schema: z.object({
                        success: z.boolean(),
                    }),
                },
            },
        },
    },
});
