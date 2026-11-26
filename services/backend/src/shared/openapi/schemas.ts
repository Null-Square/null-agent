/**
 * Common OpenAPI schemas used across multiple endpoints
 */

import { registry, z } from './registry';
import { MODEL_CATEGORIES } from '@null-ai/contracts';

// ============================================================================
// Common Parameter Schemas
// ============================================================================

export const SessionIdParamSchema = z.object({
    sessionId: z.string().uuid(),
});

export const RequestIdParamSchema = z.object({
    requestId: z.string(),
});

// ============================================================================
// Common Response Schemas
// ============================================================================

export const ErrorResponseSchema = z.object({
    error: z.string(),
    code: z.string().optional(),
    message: z.string().optional(),
});

export const SuccessResponseSchema = z.object({
    success: z.boolean(),
});

// Session Status - canonical values from contracts
// See packages/contracts/src/session/types.ts for canonical values
import { SESSION_STATUSES } from '@null-ai/contracts';

export const SessionStatusSchema = z.enum([
    ...SESSION_STATUSES,
]);

// ============================================================================
// Message Schema
// ============================================================================

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool']);

export const MessageSchema = z.object({
    id: z.string(),
    role: MessageRoleSchema,
    content: z.string(),
    timestamp: z.number(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    status: z.enum(['sending', 'sent', 'error']).optional(),
    createdAt: z.string().optional(),
});

// ============================================================================
// Plan Item Schema
// ============================================================================

export const PlanItemStatusSchema = z.enum([
    'pending',
    'running',
    'completed',
    'blocked',
    'error',
]);

export const PlanItemSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: PlanItemStatusSchema,
    notes: z.string().optional(),
    blockedReason: z.string().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
});

// ============================================================================
// Usage Schema
// ============================================================================

export const SessionUsageSchema = z.object({
    promptTokens: z.number(),
    cachedPromptTokens: z.number().optional(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    lastTurnInputTokens: z.number().optional(),
    contextWindow: z.number().nullable().optional(),
    contextRemaining: z.number().nullable().optional(),
    cost: z.number().optional(),
    model: z.string().optional(),
});

// ============================================================================
// Subscription/Tier Schemas
// ============================================================================

export const TierFeaturesSchema = z.object({
    accessAutomations: z.boolean().optional(),
    accessPrivateRunners: z.boolean().optional(),
    accessGitHubIntegrations: z.boolean().optional(),
    accessCompliance: z.boolean().optional(),
    accessCodeReview: z.boolean().optional(),
    accessThreatWatch: z.boolean().optional(),
    accessRunObservability: z.boolean().optional(),
    accessPublicTrustBadge: z.boolean().optional(),
});

export const TierLimitsSchema = z.object({
    maxConcurrentRuns: z.number().nullable().optional(),
    maxActiveScopes: z.number().nullable().optional(),
    maxAutomations: z.number().nullable().optional(),
    maxOrganizationUsers: z.number().nullable().optional(),
    allowedModelCategories: z.array(z.enum(MODEL_CATEGORIES)).nullable().optional(),
});

export const SubscriptionPlanSchema = z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    experienceProfile: z.enum(['inactive', 'results', 'workbench']).default('workbench'),
    features: TierFeaturesSchema.optional(),
    limits: TierLimitsSchema.optional(),
});

export const SubscriptionRecordSchema = z.object({
    userId: z.string().optional(),
    organizationId: z.string().uuid().optional(),
    plan: SubscriptionPlanSchema,
});

// ============================================================================
// Sandbox Images
// ============================================================================

export const SandboxImageSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    imageTag: z.string(),
    description: z.string().nullable().optional(),
    isDefault: z.boolean(),
    dockerProfileId: z.string().uuid().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

// Register schemas with the registry
registry.register('SessionIdParam', SessionIdParamSchema);
registry.register('RequestIdParam', RequestIdParamSchema);
registry.register('ErrorResponse', ErrorResponseSchema);
registry.register('SuccessResponse', SuccessResponseSchema);
registry.register('Message', MessageSchema);
registry.register('PlanItem', PlanItemSchema);
registry.register('SessionUsage', SessionUsageSchema);
registry.register('TierFeatures', TierFeaturesSchema);
registry.register('TierLimits', TierLimitsSchema);
registry.register('SubscriptionPlan', SubscriptionPlanSchema);
registry.register('SubscriptionRecord', SubscriptionRecordSchema);
registry.register('SandboxImage', SandboxImageSchema);
