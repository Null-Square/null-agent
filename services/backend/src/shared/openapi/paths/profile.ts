/**
 * Profile API path documentation
 */

import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas';
import { MODEL_CATEGORIES } from '@null-ai/contracts';

// ============================================================================
// Profile Schema
// ============================================================================

const OnboardingProgressSchema = z.object({
    version: z.literal(1),
    lastCompletedStep: z.number().int().min(0).max(5),
    formData: z.record(z.string(), z.unknown()),
    scopeId: z.string().nullable(),
    targetId: z.string().nullable(),
    targetSnapshot: z.string(),
    updatedAt: z.string(),
});

const ProfileSchema = z.object({
    id: z.string().uuid().optional(),
    user_id: z.string().uuid(),
    full_name: z.string().optional(),
    preferences: z.object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        pushNotifications: z.boolean().optional(),
        emailNotifications: z.boolean().optional(),
        cookieConsent: z.boolean().optional(),
        language: z.string().optional(),
        onboardingWelcomeSeenAt: z.string().optional(),
        onboardingCompletedAt: z.string().optional(),
        onboardingProgress: OnboardingProgressSchema.optional(),
    }).optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
});

const SubscriptionSchema = z.object({
    plan: z.object({
        id: z.string().optional(),
        slug: z.string(),
        name: z.string(),
        experienceProfile: z.enum(['inactive', 'results', 'workbench']),
        features: z.object({
            accessAutomations: z.boolean().optional(),
            accessPrivateRunners: z.boolean().optional(),
            accessGitHubIntegrations: z.boolean().optional(),
            accessCompliance: z.boolean().optional(),
            accessCodeReview: z.boolean().optional(),
            accessRunObservability: z.boolean().optional(),
            accessThreatWatch: z.boolean().optional(),
            accessPublicTrustBadge: z.boolean().optional(),
        }).optional(),
        limits: z.object({
            maxConcurrentRuns: z.number().nullable().optional(),
            maxActiveScopes: z.number().nullable().optional(),
            maxAutomations: z.number().nullable().optional(),
            maxOrganizationUsers: z.number().nullable().optional(),
            allowedModelCategories: z.array(z.enum(MODEL_CATEGORIES)).nullable().optional(),
        }).optional(),
    }),
});

// ============================================================================
// GET /profile - Get profile
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/profile',
    tags: ['Profile'],
    summary: 'Get user profile',
    description: 'Returns the profile for the authenticated user.',
    responses: {
        200: {
            description: 'User profile',
            content: {
                'application/json': {
                    schema: z.object({
                        profile: ProfileSchema.nullable(),
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

// ============================================================================
// GET /profile/full - Get full profile
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/profile/full',
    tags: ['Profile'],
    summary: 'Get full profile',
    description: 'Returns the complete profile with all fields.',
    responses: {
        200: {
            description: 'Full profile',
            content: {
                'application/json': {
                    schema: z.object({
                        data: z.object({
                            profile: ProfileSchema.nullable(),
                        }),
                    }),
                },
            },
        },
    },
});

// ============================================================================
// PUT /profile - Update profile
// ============================================================================

registry.registerPath({
    method: 'put',
    path: '/api/profile',
    tags: ['Profile'],
    summary: 'Update profile',
    description: 'Updates the user profile.',
    request: {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        full_name: z.string().optional(),
                        name: z.string().optional(),
                        preferences: z.object({
                            theme: z.enum(['light', 'dark', 'system']).optional(),
                            pushNotifications: z.boolean().optional(),
                            emailNotifications: z.boolean().optional(),
                            cookieConsent: z.boolean().optional(),
                            language: z.string().optional(),
                            onboardingWelcomeSeenAt: z.string().optional(),
                            onboardingCompletedAt: z.string().optional(),
                            onboardingProgress: OnboardingProgressSchema.optional(),
                        }).optional(),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'Profile updated',
            content: {
                'application/json': {
                    schema: z.object({
                        message: z.string(),
                        profile: ProfileSchema,
                    }),
                },
            },
        },
    },
});

// ============================================================================
// POST /profile - Create/update profile
// ============================================================================

registry.registerPath({
    method: 'post',
    path: '/api/profile',
    tags: ['Profile'],
    summary: 'Create or update profile',
    description: 'Creates or updates the user profile.',
    request: {
        body: {
            content: {
                'application/json': {
                    schema: z.object({
                        full_name: z.string().optional(),
                        name: z.string().optional(),
                        preferences: z.object({
                            theme: z.enum(['light', 'dark', 'system']).optional(),
                            pushNotifications: z.boolean().optional(),
                            emailNotifications: z.boolean().optional(),
                            cookieConsent: z.boolean().optional(),
                            language: z.string().optional(),
                            onboardingWelcomeSeenAt: z.string().optional(),
                            onboardingCompletedAt: z.string().optional(),
                            onboardingProgress: OnboardingProgressSchema.optional(),
                        }).optional(),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: 'Profile created/updated',
            content: {
                'application/json': {
                    schema: z.object({
                        message: z.string(),
                        profile: ProfileSchema,
                    }),
                },
            },
        },
    },
});

// ============================================================================
// GET /profile/subscription - Get subscription
// ============================================================================

registry.registerPath({
    method: 'get',
    path: '/api/profile/subscription',
    tags: ['Profile'],
    summary: 'Get subscription info',
    description: 'Returns the plan this computer runs on: the local plan, every feature and no limits.',
    responses: {
        200: {
            description: 'Subscription info',
            content: {
                'application/json': {
                    schema: z.object({
                        subscription: SubscriptionSchema,
                    }),
                },
            },
        },
    },
});
