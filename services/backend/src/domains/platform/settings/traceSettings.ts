import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';
export interface TraceSettings {
  traceInlineLimit?: number;
  stdoutChunkSize?: number;
  traceCompressOverBytes?: number;
  traceRetentionDays?: number;
  traceLogsRoot?: string;
  artifactDirName?: string;
  artifactMaxChars?: number;
}

const traceRowSchema = z
  .object({
    traceInlineLimit: z.unknown().optional(),
    stdoutChunkSize: z.unknown().optional(),
    traceCompressOverBytes: z.unknown().optional(),
    traceRetentionDays: z.unknown().optional(),
    traceLogsRoot: z.unknown().optional(),
    artifactDirName: z.unknown().optional(),
    artifactMaxChars: z.unknown().optional(),
  })
  .passthrough();

const stringSchema = z.string();
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
    throw new Error(`[TraceSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveTraceSettings = (value: unknown): TraceSettings => {
  const parsed = traceRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[TraceSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    traceInlineLimit: requireParsed(numberSchema.safeParse(data.traceInlineLimit), 'traceInlineLimit'),
    stdoutChunkSize: requireParsed(numberSchema.safeParse(data.stdoutChunkSize), 'stdoutChunkSize'),
    traceCompressOverBytes: requireParsed(numberSchema.safeParse(data.traceCompressOverBytes), 'traceCompressOverBytes'),
    traceRetentionDays: requireParsed(numberSchema.safeParse(data.traceRetentionDays), 'traceRetentionDays'),
    traceLogsRoot: requireParsed(stringSchema.safeParse(data.traceLogsRoot), 'traceLogsRoot'),
    artifactDirName: requireParsed(stringSchema.safeParse(data.artifactDirName), 'artifactDirName'),
    artifactMaxChars: requireParsed(numberSchema.safeParse(data.artifactMaxChars), 'artifactMaxChars'),
  };
};

const traceAccessors = createSettingsAccessors<TraceSettings>({
  key: 'trace',
  scope: 'TraceSettings',
  resolve: resolveTraceSettings,
  missingMessage: '[TraceSettings] Missing trace settings. Seed settings in database.',
  serialize: (value) => ({
    traceInlineLimit: value.traceInlineLimit,
    stdoutChunkSize: value.stdoutChunkSize,
    traceCompressOverBytes: value.traceCompressOverBytes,
    traceRetentionDays: value.traceRetentionDays,
    traceLogsRoot: value.traceLogsRoot,
    artifactDirName: value.artifactDirName,
    artifactMaxChars: value.artifactMaxChars,
  }),
});

export const getTraceSettings = traceAccessors.getSettings;
export const setTraceSettings = traceAccessors.setSettings;
