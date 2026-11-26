/**
 * Auth API path documentation. Null AI has no sign-in: `GET /api/auth/me` returns the local owner.
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas';

const UserSchema = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    created_at: z.string(),
    updated_at: z.string().optional(),
    role: z.enum(['user', 'admin']).optional(),
});

registry.registerPath({
    method: 'get',
    path: '/api/auth/me',
    tags: ['Auth'],
    summary: 'Get current user',
    description: 'Returns the local owner.',
    responses: {
        200: {
            description: 'User information',
            content: {
                'application/json': {
                    schema: z.object({
                        user: UserSchema,
                    }),
                },
            },
        },
        401: {
            description: 'Not authenticated',
            content: {
                'application/json': { schema: ErrorResponseSchema },
            },
        },
    },
});
