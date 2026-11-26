import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface SessionLifecycleSettings {
  maxAgeDays?: number;
  maxCountPerUser?: number;
  retentionEnabled?: boolean;
}

const sessionLifecycleRowSchema = z
  .object({
    maxAgeDays: z.unknown().optional(),
    maxCountPerUser: z.unknown().optional(),
    retentionEnabled: z.unknown().optional(),
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
const booleanSchema = z.boolean();

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[SessionLifecycleSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveSessionLifecycleSettings = (value: unknown): SessionLifecycleSettings => {
  const parsed = sessionLifecycleRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[SessionLifecycleSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    maxAgeDays: requireParsed(numberSchema.safeParse(data.maxAgeDays), 'maxAgeDays'),
    maxCountPerUser: requireParsed(numberSchema.safeParse(data.maxCountPerUser), 'maxCountPerUser'),
    retentionEnabled: requireParsed(booleanSchema.safeParse(data.retentionEnabled), 'retentionEnabled'),
  };
};

const sessionLifecycleAccessors = createSettingsAccessors<SessionLifecycleSettings>({
  key: 'session_lifecycle',
  scope: 'SessionLifecycleSettings',
  resolve: resolveSessionLifecycleSettings,
  missingMessage:
    '[SessionLifecycleSettings] Missing session lifecycle settings. Seed settings in database.',
  serialize: (value) => ({
    maxAgeDays: value.maxAgeDays,
    maxCountPerUser: value.maxCountPerUser,
    retentionEnabled: value.retentionEnabled,
  }),
});

export const getSessionLifecycleSettings = sessionLifecycleAccessors.getSettings;
export const setSessionLifecycleSettings = sessionLifecycleAccessors.setSettings;

export const clearSessionLifecycleSettingsCache = (): void => {
  sessionLifecycleAccessors.clearSettings();
};
