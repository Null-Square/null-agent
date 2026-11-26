/**
 * Health API path documentation
 */

import { registry, z } from '../registry';

// ============================================================================
// GET /health - Health check
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/health',
    tags: ['Health'],
    summary: 'Health check',
    description: 'Returns the health status of the API.',
    security: [], // No auth required
    responses: {
        200: {
            description: 'Service is healthy',
            content: {
                'application/json': {
                    schema: z.object({
                        status: z.literal('ok'),
                        timestamp: z.string(),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /health/detailed - Detailed health check
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/health/detailed',
    tags: ['Health'],
    summary: 'Detailed health check',
    description: 'Returns detailed health information including database and service status.',
    responses: {
        200: {
            description: 'Detailed health status',
            content: {
                'application/json': {
                    schema: z.object({
                        status: z.enum(['ok', 'degraded', 'unhealthy']),
                        uptime: z.number(),
                        timestamp: z.string(),
                        services: z.object({
                            database: z.enum(['ok', 'error']),
                            redis: z.enum(['ok', 'error']).optional(),
                            llm: z.enum(['ok', 'error']).optional(),
                        }),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /health/extended - Extended health check (admin/ops)
// ============================================================================

const DependencyStatusSchema = z.object({
    status: z.enum(['ok', 'down', 'disabled']),
    latencyMs: z.number().optional(),
    error: z.string().optional(),
    bucket: z.string().optional(),
});

const DatabaseStatusSchema = z.object({
    status: z.enum(['ok', 'down']),
    latencyMs: z.number().optional(),
    error: z.string().optional(),
});

const SandboxesStatusSchema = z.object({
    count: z.number(),
    healthy: z.boolean(),
});

const ExtendedHealthSchema = z.object({
    status: z.string(),
    timestamp: z.string(),
    role: z.string().optional(),
    workersEnabled: z.boolean().optional(),
    redis: z.string().optional(),
    sandboxes: z.union([SandboxesStatusSchema, z.literal('error')]).optional(),
    sandboxesError: z.string().optional(),
    database: DatabaseStatusSchema.optional(),
    s3Artifacts: DependencyStatusSchema.optional(),
    s3Traces: DependencyStatusSchema.optional(),
    s3Workspaces: DependencyStatusSchema.optional(),
});

registry.registerPath({
    method: 'get',
    path: '/health/extended',
    tags: ['Health'],
    summary: 'Extended health check',
    description: 'Returns extended health information including sandbox status and dependencies.',
    security: [],
    responses: {
        200: {
            description: 'Extended health status',
            content: {
                'application/json': {
                    schema: ExtendedHealthSchema,
                },
            },
        },
        503: {
            description: 'Extended health status with failures',
            content: {
                'application/json': {
                    schema: ExtendedHealthSchema,
                },
            },
        },
    },
});
