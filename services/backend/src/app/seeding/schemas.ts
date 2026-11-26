/**
 * Zod schemas for seed entity validation.
 * These schemas are used to validate seed manifest files before inserting into the database.
 */
import { z } from 'zod';
import { DEFAULT_MODEL_CATEGORY, MODEL_CATEGORIES } from '@null-ai/contracts';

// ============================================================================
// Common Types
// ============================================================================

const UUIDSchema = z.string().uuid().optional();

// ============================================================================
// Models Seed Schema
// ============================================================================

export const ModelSeedSchema = z.object({
    id: UUIDSchema,
    name: z.string().min(1),
    provider: z.string().min(1),
    modelName: z.string().min(1),
    description: z.string().optional(),
    /** Connect this entry when nothing is connected yet (before any .env key). */
    isDefault: z.boolean().default(false),
    selectionCategory: z.enum(MODEL_CATEGORIES).default(DEFAULT_MODEL_CATEGORY),
    selectionPriority: z.number().int().default(100),
    requestProfile: z.record(z.string(), z.unknown()).default({}),
    rateCards: z.array(z.object({
        effectiveFrom: z.string().datetime(),
        effectiveTo: z.string().datetime().nullable().optional(),
        currency: z.string().trim().min(1).default('usd'),
        cacheHitInputPer1m: z.number().nonnegative(),
        cacheMissInputPer1m: z.number().nonnegative(),
        outputPer1m: z.number().nonnegative(),
        sourceUrl: z.string().url().optional(),
        sourceNote: z.string().optional(),
        windows: z.array(z.object({
            name: z.string().trim().min(1),
            startMinuteUtc: z.number().int().min(0).max(1439),
            endMinuteUtc: z.number().int().min(1).max(1440),
            cacheHitInputPer1m: z.number().nonnegative(),
            cacheMissInputPer1m: z.number().nonnegative(),
            outputPer1m: z.number().nonnegative(),
        })).default([]),
    })).default([]),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    apiKeyEnv: z.string().optional(),
    apiKey: z.string().optional(),
    apiBaseUrl: z.string().url().optional(),
});

export type ModelSeed = z.infer<typeof ModelSeedSchema>;

// ============================================================================
// Settings Seed Schemas (for DB-backed config)
// ============================================================================

export const SandboxSettingsSeedSchema = z.object({
    devUnsafe: z.boolean(),
    stdoutLimitBytes: z.number().int().positive(),
    cpuQuota: z.number().positive(),
    memoryMb: z.number().positive(),
    pidsLimit: z.number().int().positive(),
});

export type SandboxSettingsSeed = z.infer<typeof SandboxSettingsSeedSchema>;

export const RuntimeSettingsSeedSchema = z.object({
    turnTimeoutMs: z.number().int().positive(),
    maxToolCallsPerTurn: z.number().int().positive(),
    shellTimeoutMs: z.number().int().positive(),
    webTimeoutMs: z.number().int().positive(),
    webMaxBytes: z.number().int().positive(),
    sessionTTLMinutes: z.number().int().positive(),
});

export type RuntimeSettingsSeed = z.infer<typeof RuntimeSettingsSeedSchema>;

export const TraceSettingsSeedSchema = z.object({
    traceInlineLimit: z.number().int().positive(),
    stdoutChunkSize: z.number().int().positive(),
    traceCompressOverBytes: z.number().int().positive(),
    traceRetentionDays: z.number().int().positive(),
    traceLogsRoot: z.string(),
    artifactDirName: z.string(),
    artifactMaxChars: z.number().int().positive(),
});

export type TraceSettingsSeed = z.infer<typeof TraceSettingsSeedSchema>;

export const AutomationSettingsSeedSchema = z.object({
    maxGuardRetries: z.number().int().nonnegative(),
    requireReport: z.boolean(),
    turnTimeoutMs: z.number().int().positive(),
    checkpointIntervalToolCalls: z.number().int().nonnegative(),
    reportMinLength: z.number().int().nonnegative(),
    workspaceBackupEnabled: z.boolean(),
});

export type AutomationSettingsSeed = z.infer<typeof AutomationSettingsSeedSchema>;

export const ThreatWatchSettingsSeedSchema = z.object({
    syncEnabled: z.boolean(),
    // Floored at NVD's requested minimum polling interval.
    syncIntervalMinutes: z.number().int().min(120),
    maxPagesPerRun: z.number().int().positive(),
    notificationsEnabled: z.boolean(),
    notificationActivationAt: z.string().datetime({ offset: true }).nullable(),
    notificationEvidenceMaxAgeDays: z.number().int().min(1).max(90),
    immediateNotifyMinPriority: z.number().min(0).max(100),
    immediateNotifyOnKev: z.boolean(),
    maxImmediateNotificationsPerDay: z.number().int().nonnegative(),
});

export type ThreatWatchSettingsSeed = z.infer<typeof ThreatWatchSettingsSeedSchema>;

export const NetworkSettingsSeedSchema = z.object({
    allowOutbound: z.boolean(),
    outboundAllowlist: z.array(z.string()),
    corsAllowedOrigins: z.array(z.string()).min(1),
});

export type NetworkSettingsSeed = z.infer<typeof NetworkSettingsSeedSchema>;

export const HttpSettingsSeedSchema = z.object({
    logSlowMs: z.number().int().positive(),
    logDebugSampleRate: z.number().min(0).max(1),
    logQuietPaths: z.array(z.string()),
    uploadsMaxBytes: z.number().int().positive(),
});

export type HttpSettingsSeed = z.infer<typeof HttpSettingsSeedSchema>;

export const WebSearchSettingsSeedSchema = z.object({
    provider: z.enum(['duck', 'tavily']),
    duckBaseUrl: z.string().url(),
    duckLiteBaseUrl: z.string().url(),
    tavilyBaseUrl: z.string().url(),
    maxResults: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    maxBytes: z.number().int().positive(),
    tavilyApiKey: z.string().nullable(),
});

export type WebSearchSettingsSeed = z.infer<typeof WebSearchSettingsSeedSchema>;

export const TokenGuardSettingsSeedSchema = z.object({
    perSessionLimit: z.number().int().nonnegative(),
    perUserDailyLimit: z.number().int().nonnegative(),
    warningThresholdPct: z.number().int().min(0).max(100),
});

export type TokenGuardSettingsSeed = z.infer<typeof TokenGuardSettingsSeedSchema>;

export const SessionLifecycleSettingsSeedSchema = z.object({
    maxAgeDays: z.number().int().nonnegative(),
    maxCountPerUser: z.number().int().nonnegative(),
    retentionEnabled: z.boolean(),
});

export type SessionLifecycleSettingsSeed = z.infer<typeof SessionLifecycleSettingsSeedSchema>;

export const ComponentAliasSeedSchema = z.object({
    aliasText: z.string().min(1),
    ecosystem: z.enum([
        'cpe',
        'wordpress_core',
        'wordpress_plugin',
        'wordpress_theme',
        'npm',
        'pypi',
        'composer',
        'go',
        'maven',
        'cargo',
        'rubygems',
        'oci',
    ]),
    componentKey: z.string().min(1),
    confidence: z.number().min(0).max(1).optional(),
}).strict();

export const ComponentAliasCatalogSeedSchema = z.object({
    catalogVersion: z.string().min(1),
    note: z.string().optional(),
    aliases: z.array(ComponentAliasSeedSchema).min(1),
}).strict();

export type ComponentAliasCatalogSeed = z.infer<typeof ComponentAliasCatalogSeedSchema>;
