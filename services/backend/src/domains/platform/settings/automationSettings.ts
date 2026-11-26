import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface AutomationSettings {
  maxGuardRetries?: number;
  requireReport?: boolean;
  turnTimeoutMs?: number;
  checkpointIntervalToolCalls?: number;
  reportMinLength?: number;
  workspaceBackupEnabled?: boolean;
}

const automationRowSchema = z
  .object({
    maxGuardRetries: z.unknown().optional(),
    requireReport: z.unknown().optional(),
    turnTimeoutMs: z.unknown().optional(),
    checkpointIntervalToolCalls: z.unknown().optional(),
    reportMinLength: z.unknown().optional(),
    workspaceBackupEnabled: z.unknown().optional(),
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

const booleanSchema = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return value;
}, z.boolean());

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[AutomationSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveAutomationSettings = (value: unknown): AutomationSettings => {
  const parsed = automationRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[AutomationSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    maxGuardRetries: requireParsed(numberSchema.safeParse(data.maxGuardRetries), 'maxGuardRetries'),
    requireReport: requireParsed(booleanSchema.safeParse(data.requireReport), 'requireReport'),
    turnTimeoutMs: requireParsed(numberSchema.safeParse(data.turnTimeoutMs), 'turnTimeoutMs'),
    checkpointIntervalToolCalls: requireParsed(
      numberSchema.safeParse(data.checkpointIntervalToolCalls),
      'checkpointIntervalToolCalls',
    ),
    reportMinLength: requireParsed(numberSchema.safeParse(data.reportMinLength), 'reportMinLength'),
    workspaceBackupEnabled: requireParsed(
      booleanSchema.safeParse(data.workspaceBackupEnabled),
      'workspaceBackupEnabled',
    ),
  };
};

const automationAccessors = createSettingsAccessors<AutomationSettings>({
  key: 'automation',
  scope: 'AutomationSettings',
  resolve: resolveAutomationSettings,
  missingMessage:
    '[AutomationSettings] Missing automation settings. Seed settings in database.',
  serialize: (value) => ({
    maxGuardRetries: value.maxGuardRetries,
    requireReport: value.requireReport,
    turnTimeoutMs: value.turnTimeoutMs,
    checkpointIntervalToolCalls: value.checkpointIntervalToolCalls,
    reportMinLength: value.reportMinLength,
    workspaceBackupEnabled: value.workspaceBackupEnabled,
  }),
});

export const getAutomationSettings = automationAccessors.getSettings;
export const setAutomationSettings = automationAccessors.setSettings;

export const clearAutomationSettingsCache = (): void => {
  automationAccessors.clearSettings();
};
