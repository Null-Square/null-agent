import { logger } from '@/shared/logger';
import { settingsService } from './SettingsService';

type SettingsAccessorOptions<T> = {
  key: string;
  scope: string;
  resolve: (value: unknown) => T;
  serialize: (value: T) => Record<string, unknown>;
  freshReads?: boolean;
  missingMessage?: string;
  fallbackValue?: (error: unknown) => T;
  fallbackMessage?: string;
};

type SettingsAccessors<T> = {
  getSettings: () => Promise<T>;
  setSettings: (settings: Partial<T>) => Promise<void>;
  clearSettings: () => void;
};

export const createSettingsAccessors = <T>(
  options: SettingsAccessorOptions<T>,
): SettingsAccessors<T> => {
  const getSettings = async (): Promise<T> => {
    try {
      return await settingsService.getParsed(
        options.key,
        options.resolve,
        {
          ...(options.missingMessage
            ? { onMissing: () => new Error(options.missingMessage) }
            : {}),
          fresh: options.freshReads,
        },
      );
    } catch (error) {
      if (options.fallbackValue) {
        logger.warn(
          { err: error },
          options.fallbackMessage ??
            `[${options.scope}] Failed to load ${options.key} settings, using fallback`,
        );
        return options.fallbackValue(error);
      }
      logger.warn(
        { err: error },
        `[${options.scope}] Failed to load ${options.key} settings`,
      );
      throw error;
    }
  };

  const setSettings = async (settings: Partial<T>): Promise<void> => {
    const existing = await settingsService.getRaw(options.key, {
      fresh: options.freshReads,
    });
    const merged = {
      ...(existing ? options.resolve(existing) : {}),
      ...settings,
    };
    const resolved = options.resolve(merged);
    await settingsService.setParsed(options.key, resolved, options.serialize);
  };

  const clearSettings = (): void => {
    settingsService.invalidate(options.key);
  };

  return {
    getSettings,
    setSettings,
    clearSettings,
  };
};
