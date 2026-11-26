import { SettingsRepository } from './SettingsRepository';
import { logger } from '@/shared/logger';

export type SettingsParser<T> = (value: unknown) => T;
export type SettingsSerializer<T> = (value: T) => Record<string, unknown>;

type ParsedCacheEntry = {
  value: unknown;
  updatedAt: number;
};

type SettingsReadOptions = {
  fresh?: boolean;
};

/**
 * SettingsService centralizes settings access, caching, and persistence.
 * - Single repository instance
 * - Shared cache by key
 * - Consistent get/set behavior
 */
export class SettingsService {
  private readonly repository: SettingsRepository;
  private readonly parsedCache = new Map<string, ParsedCacheEntry>();
  private readonly rawCache = new Map<string, Record<string, unknown>>();

  constructor(repository: SettingsRepository = new SettingsRepository()) {
    this.repository = repository;
  }

  async preload(keys: string[]): Promise<void> {
    const uncached = keys.filter((k) => !this.rawCache.has(k));
    if (uncached.length === 0) return;
    const rows = await this.repository.getMany(uncached);
    for (const [key, value] of rows) {
      this.rawCache.set(key, value);
    }
  }

  async getRaw(key: string, options?: SettingsReadOptions): Promise<Record<string, unknown> | null> {
    if (!options?.fresh && this.rawCache.has(key)) {
      return this.rawCache.get(key) ?? null;
    }
    const row = await this.repository.get(key);
    if (row) {
      this.rawCache.set(key, row);
    }
    return row ?? null;
  }

  async getParsed<T>(
    key: string,
    parser: SettingsParser<T>,
    options?: { onMissing?: () => Error; fresh?: boolean },
  ): Promise<T> {
    const cached = this.parsedCache.get(key);
    if (!options?.fresh && cached) {
      return cached.value as T;
    }

    const row = await this.getRaw(key, { fresh: options?.fresh });
    if (!row) {
      if (options?.onMissing) {
        throw options.onMissing();
      }
      throw new Error(`[SettingsService] Missing settings: ${key}`);
    }

    try {
      const parsed = parser(row);
      this.parsedCache.set(key, { value: parsed, updatedAt: Date.now() });
      return parsed;
    } catch (error) {
      logger.warn({ err: error, key }, '[SettingsService] Failed to parse settings');
      throw error;
    }
  }

  async setParsed<T>(
    key: string,
    value: T,
    serializer: SettingsSerializer<T>,
  ): Promise<void> {
    const raw = serializer(value);
    await this.repository.set(key, raw);
    this.rawCache.set(key, raw);
    this.parsedCache.set(key, { value, updatedAt: Date.now() });
  }

  async compareAndSetParsed<T>(
    key: string,
    expected: { field: string; value: number },
    value: T,
    serializer: SettingsSerializer<T>,
  ): Promise<boolean> {
    const raw = serializer(value);
    const updated = await this.repository.compareAndSetJsonNumber(
      key,
      expected.field,
      expected.value,
      raw,
    );
    if (updated) {
      this.rawCache.set(key, raw);
      this.parsedCache.set(key, { value, updatedAt: Date.now() });
    } else {
      this.invalidate(key);
    }
    return updated;
  }

  invalidate(key?: string): void {
    if (!key) {
      this.parsedCache.clear();
      this.rawCache.clear();
      return;
    }
    this.parsedCache.delete(key);
    this.rawCache.delete(key);
  }
}

export const settingsService = new SettingsService();
