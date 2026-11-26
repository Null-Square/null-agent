import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface TokenGuardSettings {
  perSessionLimit?: number;
  perUserDailyLimit?: number;
  warningThresholdPct?: number;
}

const tokenGuardRowSchema = z
  .object({
    perSessionLimit: z.unknown().optional(),
    perUserDailyLimit: z.unknown().optional(),
    warningThresholdPct: z.unknown().optional(),
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
    throw new Error(`[TokenGuardSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveTokenGuardSettings = (value: unknown): TokenGuardSettings => {
  const parsed = tokenGuardRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[TokenGuardSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    perSessionLimit: requireParsed(numberSchema.safeParse(data.perSessionLimit), 'perSessionLimit'),
    perUserDailyLimit: requireParsed(numberSchema.safeParse(data.perUserDailyLimit), 'perUserDailyLimit'),
    warningThresholdPct: requireParsed(numberSchema.safeParse(data.warningThresholdPct), 'warningThresholdPct'),
  };
};

const tokenGuardAccessors = createSettingsAccessors<TokenGuardSettings>({
  key: 'token_guard',
  scope: 'TokenGuardSettings',
  freshReads: true,
  resolve: resolveTokenGuardSettings,
  missingMessage:
    '[TokenGuardSettings] Missing token guard settings. Seed settings in database.',
  serialize: (value) => ({
    perSessionLimit: value.perSessionLimit,
    perUserDailyLimit: value.perUserDailyLimit,
    warningThresholdPct: value.warningThresholdPct,
  }),
});

export const getTokenGuardSettings = tokenGuardAccessors.getSettings;
export const setTokenGuardSettings = tokenGuardAccessors.setSettings;

export const clearTokenGuardSettingsCache = (): void => {
  tokenGuardAccessors.clearSettings();
};
