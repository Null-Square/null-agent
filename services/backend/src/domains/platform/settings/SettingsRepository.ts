import { db } from '@/db/client';
import { settings } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

export class SettingsRepository {
  constructor(private readonly database = db) {}

  async get(key: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.database.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row ? (row.value as Record<string, unknown>) : null;
  }

  async getMany(keys: string[]): Promise<Map<string, Record<string, unknown>>> {
    if (keys.length === 0) return new Map();
    const rows = await this.database.select().from(settings).where(inArray(settings.key, keys));
    return new Map(rows.map((r) => [r.key, r.value as Record<string, unknown>]));
  }

  async set(key: string, value: Record<string, unknown>): Promise<void> {
    const existing = await this.get(key);
    if (existing) {
      await this.database
        .update(settings)
        .set({ value, updatedAt: new Date() })
        .where(eq(settings.key, key));
    } else {
      await this.database.insert(settings).values({ key, value });
    }
  }

  async compareAndSetJsonNumber(
    key: string,
    field: string,
    expectedValue: number,
    value: Record<string, unknown>,
  ): Promise<boolean> {
    const [updated] = await this.database
      .update(settings)
      .set({ value, updatedAt: new Date() })
      .where(and(
        eq(settings.key, key),
        sql`COALESCE((${settings.value} ->> ${field})::integer, 1) = ${expectedValue}`,
      ))
      .returning({ key: settings.key });
    return Boolean(updated);
  }

  async delete(key: string): Promise<void> {
    await this.database.delete(settings).where(eq(settings.key, key));
  }
}
