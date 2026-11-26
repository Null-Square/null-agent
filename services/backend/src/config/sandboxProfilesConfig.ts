import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';

const sandboxProfilesSchema = z.object({
  defaultProfile: z.string().min(1),
  profiles: z.record(z.string().min(1)).refine((value) => Object.keys(value).length > 0, {
    message: 'profiles must include at least one entry',
  }),
});

export type SandboxProfilesConfig = z.infer<typeof sandboxProfilesSchema>;

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../config/sandbox/profiles.json');

let cachedConfig: SandboxProfilesConfig | null = null;

const resolveConfigPath = (): string => {
  const fromEnv = process.env.SANDBOX_PROFILES_PATH?.trim();
  if (!fromEnv) {
    return DEFAULT_CONFIG_PATH;
  }
  return path.isAbsolute(fromEnv)
    ? fromEnv
    : path.resolve(process.cwd(), fromEnv);
};

export const loadSandboxProfilesConfig = async (): Promise<SandboxProfilesConfig> => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = resolveConfigPath();
  const raw = await fs.readFile(configPath, 'utf8');
  const parsed = sandboxProfilesSchema.parse(JSON.parse(raw));
  if (!parsed.profiles[parsed.defaultProfile]) {
    throw new Error(
      `[Config] sandbox defaultProfile "${parsed.defaultProfile}" does not exist in profiles map`,
    );
  }

  const imageOverride = process.env.SANDBOX_IMAGE?.trim();
  cachedConfig = imageOverride
    ? {
        ...parsed,
        profiles: Object.fromEntries(
          Object.keys(parsed.profiles).map((profile) => [profile, imageOverride]),
        ),
      }
    : parsed;
  return cachedConfig;
};

export const getDefaultSandboxImage = (config: SandboxProfilesConfig): string =>
  config.profiles[config.defaultProfile];
