/**
 * OpenAPI Registry - Central registry for all API documentation
 * Compatible with @asteasolutions/zod-to-openapi v7
 */

import {
    OpenAPIRegistry,
    OpenApiGeneratorV3,
    extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Extend Zod with OpenAPI support BEFORE creating registry
extendZodWithOpenApi(z);

// Create the registry
export const registry = new OpenAPIRegistry();

// Register security scheme
registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'JWT access token',
});

// Export extended Zod for use in route definitions
export { z };

/**
 * Generate the OpenAPI document
 */
export function generateOpenAPIDocument() {
    const generator = new OpenApiGeneratorV3(registry.definitions);

    return generator.generateDocument({
        openapi: '3.0.0',
        info: {
            title: 'NullSquare AI Agent API',
            version: '1.0.0',
            description: 'API for managing AI agent sessions, tasks, and user interactions.',
            contact: {
                name: 'NullSquare',
            },
        },
        servers: [
            {
                url: 'http://localhost:3001',
                description: 'Development server',
            },
            {
                url: '{baseUrl}',
                description: 'Custom server',
                variables: {
                    baseUrl: {
                        default: 'http://localhost:3001',
                        description: 'Base URL of the API server',
                    },
                },
            },
        ],
        security: [{ bearerAuth: [] }],
        tags: [
            { name: 'Auth', description: 'Authentication and account management' },
            { name: 'Profile', description: 'User profile and onboarding' },
            { name: 'Sessions', description: 'Session management' },
            { name: 'User Actions', description: 'Agent-requested user input' },
            { name: 'Approvals', description: 'Tool execution approvals' },
            { name: 'Runs', description: 'Security assessment runs' },
            { name: 'Findings', description: 'Finding detail, evidence, and remediation context' },
            { name: 'Integrations', description: 'Organization integrations and GitHub repository mapping' },
            { name: 'Context Setup', description: 'Organization and RoE document setup' },
            { name: 'Model', description: 'The one model the agent uses: ChatGPT plan, API key, or configuration file' },
            { name: 'Health', description: 'Health checks' },
        ],
    });
}
