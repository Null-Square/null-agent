/**
 * Tools (Catalog) API path documentation
 */

import { registry, z } from '../registry';

const ToolMetaSchema = z.object({
    category: z.string(),
    risk: z.string().optional(),
    isCapability: z.boolean().optional(),
    requires: z.array(z.string()).optional(),
    returns: z.string().optional(),
});

const ToolSchema = z.object({
    id: z.string(),
    summary: z.string(),
    argsSchema: z.record(z.unknown()).optional(),
    meta: ToolMetaSchema,
});

// ============================================================================
// GET /catalog/tools - List tool catalog
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/ai-agent/catalog/tools',
    tags: ['Tools'],
    summary: 'List available tools',
    description: 'Returns the tool catalog available to the agent.',
    responses: {
        200: {
            description: 'List of tools',
            content: {
                'application/json': {
                    schema: z.object({
                        tools: z.array(ToolSchema),
                    }),
                },
            },
        },
    },
});
