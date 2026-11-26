import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface HttpSettings {
  logSlowMs: number;
  logDebugSampleRate: number;
  logQuietPaths: string[];
  uploadsMaxBytes: number;
}

const httpRowSchema = z
  .object({
    logSlowMs: z.unknown().optional(),
    logDebugSampleRate: z.unknown().optional(),
    logQuietPaths: z.unknown().optional(),
    uploadsMaxBytes: z.unknown().optional(),
  })
  .passthrough();

const numberSchema = z.coerce.number().int().positive();
const sampleRateSchema = z.coerce.number().min(0).max(1);
const stringArraySchema = z.array(z.string());

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[HttpSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveHttpSettings = (value: unknown): HttpSettings => {
  const parsed = httpRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[HttpSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    logSlowMs: requireParsed(numberSchema.safeParse(data.logSlowMs), 'logSlowMs'),
    logDebugSampleRate: requireParsed(sampleRateSchema.safeParse(data.logDebugSampleRate), 'logDebugSampleRate'),
    logQuietPaths: requireParsed(stringArraySchema.safeParse(data.logQuietPaths), 'logQuietPaths'),
    uploadsMaxBytes: requireParsed(numberSchema.safeParse(data.uploadsMaxBytes), 'uploadsMaxBytes'),
  };
};

const httpAccessors = createSettingsAccessors<HttpSettings>({
  key: 'http',
  scope: 'HttpSettings',
  resolve: resolveHttpSettings,
  missingMessage: '[HttpSettings] Missing http settings. Seed settings in database.',
  serialize: (value) => ({
    logSlowMs: value.logSlowMs,
    logDebugSampleRate: value.logDebugSampleRate,
    logQuietPaths: value.logQuietPaths,
    uploadsMaxBytes: value.uploadsMaxBytes,
  }),
});

export const getHttpSettings = httpAccessors.getSettings;
export const setHttpSettings = httpAccessors.setSettings;

export const clearHttpSettingsCache = (): void => {
  httpAccessors.clearSettings();
};
