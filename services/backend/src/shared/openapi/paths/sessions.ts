/**
 * Sessions API path documentation
 */

import { registry, z } from '../registry';
import {
    SessionIdParamSchema,
    ErrorResponseSchema,
    MessageSchema,
    PlanItemSchema,
    SessionUsageSchema,
    SessionStatusSchema,
} from '../schemas';
import { timelineEntrySchema } from '@null-ai/contracts';

const SessionPauseReasonSchema = z.enum(['manual', 'approval', 'credits', 'runner', 'system']).nullable();
const SessionInteractionTypeSchema = z.enum(['none']);
const DesiredSessionExecutionSchema = z.enum(['running', 'stopped']);
const SessionExecutionConditionSchema = z.enum([
    'executing',
    'waiting_approval',
    'waiting_credits',
    'waiting_runner',
    'waiting_prerequisite',
    'recovering',
    'completed',
    'idle',
]);
const SessionExecutionReadModelSchema = {
    desiredExecution: DesiredSessionExecutionSchema,
    condition: SessionExecutionConditionSchema,
    conditionReason: z.string().nullable().optional(),
};
const SessionArtifactSchema = z.object({
    id: z.string(),
    filePath: z.string(),
    originalName: z.string(),
    fileType: z.string().optional(),
    sizeBytes: z.number(),
    createdAt: z.number(),
    downloadUrl: z.string().optional(),
    storage: z.enum(['local', 's3']).optional(),
    bucket: z.string().optional(),
});
const SessionTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
});
const ToolStreamSchema = z.object({
    name: z.string(),
    chunks: z.array(z.string()),
    status: z.enum(['idle', 'running', 'completed', 'error']),
    command: z.string().optional(),
    result: z.unknown().optional(),
    lastUpdated: z.number(),
});
const SessionUsageHistoryEntrySchema = z.object({
    ts: z.number().optional(),
    turn: z.number().nullable().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cost: z.number().optional(),
});
const SessionMessageMutationResponseSchema = z.object({
    ...SessionExecutionReadModelSchema,
    accepted: z.boolean().optional(),
    status: z.union([SessionStatusSchema, z.literal('stale_phase_session')]),
    pause_reason: SessionPauseReasonSchema.optional(),
    interaction_type: SessionInteractionTypeSchema.optional(),
    blocked_reason: z.string().nullable().optional(),
    blocked_meta: z.record(z.unknown()).nullable().optional(),
    version: z.number().optional(),
    previousStatus: SessionStatusSchema.optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
});

// ============================================================================
// Session Response Schema
// ============================================================================

const SessionSummarySchema = z.object({
    id: z.string().uuid(),
    ...SessionExecutionReadModelSchema,
    userId: z.string().optional(),
    status: SessionStatusSchema,
    pause_reason: SessionPauseReasonSchema.optional(),
    interaction_type: SessionInteractionTypeSchema.optional(),
    blocked_reason: z.string().nullable().optional(),
    blocked_meta: z.record(z.unknown()).nullable().optional(),
    mode: z.enum(['interactive', 'automated']).optional(),
    createdAt: z.number(),
    lastActive: z.number(),
    summary: z.string().optional(),
    messageCount: z.number().optional(),
    task: z.object({
        id: z.string(),
        title: z.string(),
    }).optional(),
});

const SessionDetailsSchema = z.object({
    id: z.string().uuid(),
    ...SessionExecutionReadModelSchema,
    version: z.number().optional(),
    userId: z.string().optional(),
    status: SessionStatusSchema,
    pause_reason: SessionPauseReasonSchema.optional(),
    interaction_type: SessionInteractionTypeSchema.optional(),
    blocked_reason: z.string().nullable().optional(),
    blocked_meta: z.record(z.unknown()).nullable().optional(),
    mode: z.enum(['interactive', 'automated']).optional(),
    createdAt: z.number(),
    lastActive: z.number(),
    updatedAt: z.number().optional(),
    turn: z.number(),
    summary: z.string().optional(),
    messages: z.array(MessageSchema),
    plan: z.array(PlanItemSchema),
    usage: SessionUsageSchema.optional(),
    usageHistory: z.array(SessionUsageHistoryEntrySchema).optional(),
    artifacts: z.array(SessionArtifactSchema).optional(),
    task: SessionTaskSchema.optional(),
    liveToolStreams: z.record(ToolStreamSchema).optional(),
    timeline: z.array(timelineEntrySchema).optional(),
});

// ============================================================================
// GET /sessions - List sessions
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions',
    tags: ['Sessions'],
    summary: 'List sessions',
    description: 'Returns a paginated list of sessions for the authenticated user.',
    request: {
        query: z.object({
            limit: z.string().optional().openapi({ example: '20' }),
            offset: z.string().optional().openapi({ example: '0' }),
            status: z.string().optional().openapi({ example: 'running' }),
        }),
    },
    responses: {
        200: {
            description: 'List of sessions',
            content: {
                'application/json': {
                    schema: z.object({
                        sessions: z.array(SessionSummarySchema),
                        total: z.number().optional(),
                        hasMore: z.boolean().optional(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /models - Model categories a session can use
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/models',
    tags: ['Sessions'],
    summary: 'List model categories',
    description: 'Model categories a session can use. Concrete models stay server-side and are resolved at session start.',
    responses: {
        200: {
            description: 'Model categories',
            content: {
                'application/json': {
                    schema: z.object({
                        models: z.array(z.object({
                            id: z.string(),
                            category: z.string(),
                            displayName: z.string(),
                            description: z.string(),
                            isDefault: z.boolean(),
                            availableCount: z.number(),
                        })),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /sessions/:sessionId - Get session details
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions/{sessionId}',
    tags: ['Sessions'],
    summary: 'Get session details',
    description: 'Returns full details of a session including messages and plan.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'Session details',
            content: {
                'application/json': {
                    schema: z.object({
                        session: SessionDetailsSchema,
                    }),
                },
            },
        },
        404: {
            description: 'Session not found',
            content: {
                'application/json': { schema: ErrorResponseSchema },
            },
        },
    },
});

// ============================================================================
// POST /sessions/:sessionId/message - Send message
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/ai-agent/sessions/{sessionId}/message',
    tags: ['Sessions'],
    summary: 'Send a message to the session',
    description: 'Sends a user message to the AI agent session.',
    request: {
        params: SessionIdParamSchema,
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        text: z.string().openapi({
                            example: 'Please review this code',
                            description: 'User message content',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        202: {
            description: 'Message accepted',
            content: {
                'application/json': {
                    schema: SessionMessageMutationResponseSchema,
                },
            },
        },
        409: {
            description: 'Message rejected by session state policy',
            content: {
                'application/json': {
                    schema: SessionMessageMutationResponseSchema,
                },
            },
        },
    },
});

// ============================================================================
// POST /sessions/:sessionId/start - Start or recover session execution
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/ai-agent/sessions/{sessionId}/start',
    tags: ['Sessions'],
    summary: 'Start session execution',
    description: 'Appends durable Start intent from any lifecycle state. Recovery waits automatically for unavailable prerequisites.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'Start accepted or session already running',
            content: {
                'application/json': {
                    schema: z.object({
                        ...SessionExecutionReadModelSchema,
                        success: z.boolean(),
                        started: z.boolean(),
                        status: SessionStatusSchema,
                        pause_reason: SessionPauseReasonSchema.optional(),
                        interaction_type: SessionInteractionTypeSchema.optional(),
                        blocked_reason: z.string().nullable().optional(),
                        recovery_scheduled: z.boolean().optional(),
                        version: z.number().optional(),
                        message: z.string().optional(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// POST /sessions/:sessionId/stop - Stop session execution
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/ai-agent/sessions/{sessionId}/stop',
    tags: ['Sessions'],
    summary: 'Stop session execution',
    description: 'Appends durable Stop intent and interrupts current execution without deleting history.',
    request: {
        params: SessionIdParamSchema,
        body: {
            required: false,
            content: {
                'application/json': {
                    schema: z.object({
                        reason: z.string().max(500).optional().openapi({
                            example: 'Stopped by operator',
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'Stop accepted',
            content: {
                'application/json': {
                    schema: z.object({
                        ...SessionExecutionReadModelSchema,
                        success: z.boolean(),
                        stopped: z.boolean(),
                        status: SessionStatusSchema,
                        pause_reason: SessionPauseReasonSchema.optional(),
                        interaction_type: SessionInteractionTypeSchema.optional(),
                        blocked_reason: z.string().nullable().optional(),
                        version: z.number().optional(),
                        message: z.string().optional(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// DELETE /sessions/:sessionId - Delete session
// ============================================================================

registry.registerPath({
    method: 'delete',
    path: '/api/ai-agent/sessions/{sessionId}',
    tags: ['Sessions'],
    summary: 'Delete a session',
    description: 'Permanently deletes a session and its data.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'Session deleted',
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

// ============================================================================
// GET /sessions/:sessionId/plan - Get session plan
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions/{sessionId}/plan',
    tags: ['Sessions'],
    summary: 'Get session plan',
    description: 'Returns the execution plan for a session.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'Session plan',
            content: {
                'application/json': {
                    schema: z.object({
                        plan: z.array(PlanItemSchema),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /sessions/:sessionId/messages - Get session messages
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions/{sessionId}/messages',
    tags: ['Sessions'],
    summary: 'Get session messages',
    description: 'Returns messages for a session using opaque cursors for stable pagination.',
    request: {
        params: SessionIdParamSchema,
        query: z.object({
            limit: z.string().optional().openapi({ example: '100' }),
            cursor: z.string().optional().openapi({
                example: 'MjAyNS0xMi0wNlQxNTowMDowMC4wMDBafG1zZ19pZA==',
                description: 'Opaque cursor returned by the previous page',
            }),
            direction: z.enum(['forward', 'backward']).optional().openapi({
                example: 'forward',
            }),
        }),
    },
    responses: {
        200: {
            description: 'Session messages',
            content: {
                'application/json': {
                    schema: z.object({
                        messages: z.array(MessageSchema),
                        pagination: z.object({
                            limit: z.number(),
                            cursor: z.string().optional(),
                            hasMore: z.boolean(),
                        }),
                    }),
                },
            },
        },
    },
});
