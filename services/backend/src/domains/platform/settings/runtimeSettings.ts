import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';
export interface RuntimeSettings {
  turnTimeoutMs?: number;
  maxToolCallsPerTurn?: number;
  shellTimeoutMs?: number;
  webTimeoutMs?: number;
  webMaxBytes?: number;
  sessionTTLMinutes?: number;
}

const runtimeRowSchema = z
  .object({
    turnTimeoutMs: z.unknown().optional(),
    maxToolCallsPerTurn: z.unknown().optional(),
    shellTimeoutMs: z.unknown().optional(),
    webTimeoutMs: z.unknown().optional(),
    webMaxBytes: z.unknown().optional(),
    sessionTTLMinutes: z.unknown().optional(),
  })
  .passthrough();

const numberSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return value;
    const asNumber = Number(trimmed);
    return Number.isFinite(asNumber) ? asNumber : value;
  }
  return value;
}, z.number());

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[RuntimeSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveRuntimeSettings = (value: unknown): RuntimeSettings => {
  const parsed = runtimeRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[RuntimeSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    turnTimeoutMs: requireParsed(numberSchema.safeParse(data.turnTimeoutMs), 'turnTimeoutMs'),
    maxToolCallsPerTurn: requireParsed(numberSchema.safeParse(data.maxToolCallsPerTurn), 'maxToolCallsPerTurn'),
    shellTimeoutMs: requireParsed(numberSchema.safeParse(data.shellTimeoutMs), 'shellTimeoutMs'),
    webTimeoutMs: requireParsed(numberSchema.safeParse(data.webTimeoutMs), 'webTimeoutMs'),
    webMaxBytes: requireParsed(numberSchema.safeParse(data.webMaxBytes), 'webMaxBytes'),
    sessionTTLMinutes: requireParsed(numberSchema.safeParse(data.sessionTTLMinutes), 'sessionTTLMinutes'),
  };
};

const runtimeAccessors = createSettingsAccessors<RuntimeSettings>({
  key: 'runtime',
  scope: 'RuntimeSettings',
  resolve: resolveRuntimeSettings,
  missingMessage: '[RuntimeSettings] Missing runtime settings. Seed settings in database.',
  serialize: (value) => ({
    turnTimeoutMs: value.turnTimeoutMs,
    maxToolCallsPerTurn: value.maxToolCallsPerTurn,
    shellTimeoutMs: value.shellTimeoutMs,
    webTimeoutMs: value.webTimeoutMs,
    webMaxBytes: value.webMaxBytes,
    sessionTTLMinutes: value.sessionTTLMinutes,
  }),
});

export const getRuntimeSettings = runtimeAccessors.getSettings;
export const setRuntimeSettings = runtimeAccessors.setSettings;
