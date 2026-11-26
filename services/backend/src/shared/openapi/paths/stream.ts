/**
 * Stream API path documentation
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema, SessionIdParamSchema } from '../schemas';

// ============================================================================
// GET /ai-agent/sessions/:sessionId/stream - SSE stream
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/sessions/{sessionId}/stream',
    tags: ['Sessions'],
    summary: 'Subscribe to session events (SSE)',
    description: 'Server-Sent Events stream for real-time session updates including messages and status changes.',
    request: {
        params: SessionIdParamSchema,
    },
    responses: {
        200: {
            description: 'SSE stream established',
            content: {
                'text/event-stream': {
                    schema: z.string().describe('Server-Sent Events stream'),
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

