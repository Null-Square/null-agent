/**
 * Settings Types
 * 
 * Shared settings interfaces and Zod schemas.
 * These settings are stored in the database.
 */

import { z } from 'zod';

// ============================================================================
// Network Settings
// ============================================================================

export const networkSettingsSchema = z.object({
  corsAllowedOrigins: z.array(z.string()),
  allowOutbound: z.boolean(),
  outboundAllowlist: z.array(z.string()),
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

// ============================================================================
// Sandbox Settings
// ============================================================================

export const sandboxSettingsSchema = z.object({
  devUnsafe: z.boolean().optional(),
  stdoutLimitBytes: z.number().int().positive().optional(),
  cpuQuota: z.number().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  pidsLimit: z.number().int().positive().optional(),
});

export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

// ============================================================================
// Runtime Settings
// ============================================================================

export const runtimeSettingsSchema = z.object({
  turnTimeoutMs: z.number().int().positive().optional(),
  maxToolCallsPerTurn: z.number().int().positive().optional(),
  shellTimeoutMs: z.number().int().positive().optional(),
  webTimeoutMs: z.number().int().positive().optional(),
  webMaxBytes: z.number().int().positive().optional(),
  sessionTTLMinutes: z.number().int().positive().optional(),
});

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;

// ============================================================================
// Trace Settings
// ============================================================================

export const traceSettingsSchema = z.object({
  traceInlineLimit: z.number().int().positive().optional(),
  stdoutChunkSize: z.number().int().positive().optional(),
  traceCompressOverBytes: z.number().int().positive().optional(),
  traceRetentionDays: z.number().int().positive().optional(),
  traceLogsRoot: z.string().optional(),
  artifactDirName: z.string().optional(),
});

export type TraceSettings = z.infer<typeof traceSettingsSchema>;

// ============================================================================
// Guardrail Settings
// ============================================================================

export const guardrailSettingsSchema = z.object({
  hardRules: z.string().optional(),
  defaultProfile: z.string().optional(),
});

export type GuardrailSettings = z.infer<typeof guardrailSettingsSchema>;

// ============================================================================
// All Settings Union
// ============================================================================

export type SettingsCategory =
  | 'network'
  | 'sandbox'
  | 'runtime'
  | 'trace'
  | 'guardrails';

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  'network',
  'sandbox',
  'runtime',
  'trace',
  'guardrails',
];

