/**
 * SessionRetentionAdapter - Drizzle/PostgreSQL implementation of SessionRetentionPort
 *
 * This adapter contains the database-specific session cleanup logic.
 *
 * @module agent-brain/adapters
 */

import { db } from '@/db/client';
import { agentSessions } from '@/db/schema';
import { sql, and, lt, isNull } from 'drizzle-orm';
import type { SessionRetentionPort } from '../ports';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const RECENT_ACTIVITY_PROTECTION_MS = 60_000;

/**
 * Drizzle/PostgreSQL implementation of SessionRetentionPort.
 */
export class SessionRetentionAdapter implements SessionRetentionPort {
  constructor(private readonly database = db) {}

  async deleteOldSessions(cutoffDate: Date): Promise<number> {
    // Delete WHERE:
    //   last_active_at < cutoffDate
    //   AND next_attempt_at IS NULL
    const result = await this.database
      .delete(agentSessions)
      .where(
        and(
          lt(agentSessions.lastActiveAt, cutoffDate),
          // Not scheduled for retry
          isNull(agentSessions.nextAttemptAt),
        ),
      )
      .returning({ id: agentSessions.id });

    return result.length;
  }

  async enforceMaxCountPerUser(maxCount: number): Promise<number> {
    const recentActivityCutoff = new Date(Date.now() - RECENT_ACTIVITY_PROTECTION_MS);

    // Find and delete sessions beyond the cap per user
    // Protected: very recent activity, pending retry
    const result = await this.database.execute(sql`
      WITH ranked AS (
        SELECT 
          id,
          user_id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY last_active_at DESC) as rn
        FROM agent_sessions
        WHERE 
          last_active_at < ${recentActivityCutoff}
          AND next_attempt_at IS NULL
      ),
      to_delete AS (
        SELECT id FROM ranked WHERE rn > ${maxCount}
      )
      DELETE FROM agent_sessions WHERE id IN (SELECT id FROM to_delete)
      RETURNING id
    `);

    const rows = Array.isArray(result)
      ? result
      : (isRecord(result) && Array.isArray(result.rows) ? result.rows : []);
    return rows.length;
  }
}

/**
 * Default singleton instance for convenience.
 */
export const sessionRetentionAdapter = new SessionRetentionAdapter();
