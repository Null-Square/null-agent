import { z } from 'zod';
import { createSettingsAccessors } from './settingsAccessors';

export interface NetworkSettings {
  corsAllowedOrigins: string[];
  allowOutbound: boolean;
  outboundAllowlist: string[];
}

const networkRowSchema = z
  .object({
    corsAllowedOrigins: z.unknown().optional(),
    allowOutbound: z.unknown().optional(),
    outboundAllowlist: z.unknown().optional(),
  })
  .passthrough();

const stringArraySchema = z.array(z.string());
const corsOriginsSchema = z.array(z.string()).min(1);
const booleanSchema = z.boolean();

const requireParsed = <T>(result: z.SafeParseReturnType<unknown, T>, key: string): T => {
  if (!result.success) {
    throw new Error(`[NetworkSettings] Missing or invalid setting: ${key}`);
  }
  return result.data;
};

const resolveNetworkSettings = (value: unknown): NetworkSettings => {
  const parsed = networkRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('[NetworkSettings] Invalid settings row');
  }
  const data = parsed.data;
  return {
    corsAllowedOrigins: requireParsed(corsOriginsSchema.safeParse(data.corsAllowedOrigins), 'corsAllowedOrigins'),
    allowOutbound: requireParsed(booleanSchema.safeParse(data.allowOutbound), 'allowOutbound'),
    outboundAllowlist: requireParsed(stringArraySchema.safeParse(data.outboundAllowlist), 'outboundAllowlist'),
  };
};

/**
 * Fallback CORS origins used when DB settings fail to load.
 * This ensures the backend remains accessible even during initial setup.
 */
const FALLBACK_CORS_ORIGINS = [
  '*.localhost',
];

const networkAccessors = createSettingsAccessors<NetworkSettings>({
  key: 'network',
  scope: 'NetworkSettings',
  resolve: resolveNetworkSettings,
  fallbackMessage:
    '[NetworkSettings] Failed to load network settings, using fallback',
  fallbackValue: () => ({
    corsAllowedOrigins: FALLBACK_CORS_ORIGINS,
    allowOutbound: true,
    outboundAllowlist: [],
  }),
  serialize: (value) => ({
    corsAllowedOrigins: value.corsAllowedOrigins,
    allowOutbound: value.allowOutbound,
    outboundAllowlist: value.outboundAllowlist,
  }),
});

export const getNetworkSettings = networkAccessors.getSettings;
export const setNetworkSettings = networkAccessors.setSettings;
