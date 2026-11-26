import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

// NOTE: defaultProfile removed (Dec 2025) - sandbox/tool policy default is file-backed.
export interface SandboxSettings {
  devUnsafe?: boolean;
  cpuQuota?: number;
  memoryMb?: number;
  pidsLimit?: number;
  stdoutLimitBytes?: number;
}

const sandboxRowSchema = z
  .object({
    devUnsafe: z.unknown().optional(),
    cpuQuota: z.unknown().optional(),
    memoryMb: z.unknown().optional(),
    pidsLimit: z.unknown().optional(),
    stdoutLimitBytes: z.unknown().optional(),
  })
  .passthrough();

const booleanSchema = z.boolean();
const numberSchema = z.number();

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[SandboxSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveSandboxSettings = (value: unknown): SandboxSettings => {
  const parsed = sandboxRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[SandboxSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    devUnsafe: requireParsed(booleanSchema.safeParse(data.devUnsafe), 'devUnsafe'),
    cpuQuota: requireParsed(numberSchema.safeParse(data.cpuQuota), 'cpuQuota'),
    memoryMb: requireParsed(numberSchema.safeParse(data.memoryMb), 'memoryMb'),
    pidsLimit: requireParsed(numberSchema.safeParse(data.pidsLimit), 'pidsLimit'),
    stdoutLimitBytes: requireParsed(numberSchema.safeParse(data.stdoutLimitBytes), 'stdoutLimitBytes'),
  };
};

const sandboxAccessors = createSettingsAccessors<SandboxSettings>({
  key: 'sandbox',
  scope: 'SandboxSettings',
  resolve: resolveSandboxSettings,
  missingMessage: '[SandboxSettings] Missing sandbox settings. Seed settings in database.',
  serialize: (value) => ({
    devUnsafe: value.devUnsafe,
    cpuQuota: value.cpuQuota,
    memoryMb: value.memoryMb,
    pidsLimit: value.pidsLimit,
    stdoutLimitBytes: value.stdoutLimitBytes,
  }),
});

export const getSandboxSettings = sandboxAccessors.getSettings;
export const setSandboxSettings = sandboxAccessors.setSettings;

