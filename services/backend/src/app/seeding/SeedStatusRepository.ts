/**
 * SeedStatusRepository
 * 
 * Tracks which database seeds have been applied.
 * A seed runs once; after that the database holds the values.
 */

import { db } from '@/db/client';
import { seedStatus, type SeedStatusRow } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface SeedInfo {
  name: string;
  applied: boolean;
  appliedAt?: Date;
  version?: string;
}

export class SeedStatusRepository {
  /**
   * Check if a seed has already been applied
   */
  async isApplied(seedName: string): Promise<boolean> {
    const [row] = await db
      .select()
      .from(seedStatus)
      .where(eq(seedStatus.seedName, seedName))
      .limit(1);
    return !!row;
  }

  /**
   * Mark a seed as applied
   */
  async markApplied(seedName: string, version?: string): Promise<void> {
    await db
      .insert(seedStatus)
      .values({
        seedName,
        version,
        appliedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: seedStatus.seedName,
        set: {
          appliedAt: new Date(),
          version,
        },
      });
  }

  /**
   * Remove applied status (for re-seeding)
   */
  async markPending(seedName: string): Promise<void> {
    await db.delete(seedStatus).where(eq(seedStatus.seedName, seedName));
  }

  /**
   * Get status of all seeds
   */
  async getAll(): Promise<SeedStatusRow[]> {
    return db.select().from(seedStatus);
  }

  /**
   * Get info for a specific seed
   */
  async getInfo(seedName: string): Promise<SeedInfo> {
    const [row] = await db
      .select()
      .from(seedStatus)
      .where(eq(seedStatus.seedName, seedName))
      .limit(1);
    
    return {
      name: seedName,
      applied: !!row,
      appliedAt: row?.appliedAt,
      version: row?.version ?? undefined,
    };
  }

  /**
   * Get list of all known seeds with their status
   */
  async getAllWithKnownSeeds(knownSeeds: string[]): Promise<SeedInfo[]> {
    const applied = await this.getAll();
    const appliedMap = new Map(applied.map(r => [r.seedName, r]));

    return knownSeeds.map(name => {
      const row = appliedMap.get(name);
      return {
        name,
        applied: !!row,
        appliedAt: row?.appliedAt,
        version: row?.version ?? undefined,
      };
    });
  }
}

// Singleton instance
export const seedStatusRepository = new SeedStatusRepository();
