/**
 * SessionRetentionPort - Port interface for session retention operations
 *
 * This port abstracts the database cleanup operations for session retention,
 * allowing the core domain to remain infrastructure-agnostic.
 *
 * @module agent-brain/core/ports
 */

/**
 * Port interface for session retention repository operations.
 *
 * Implementations:
 * - SessionRetentionAdapter (Drizzle/PostgreSQL)
 */
export interface SessionRetentionPort {
  /**
   * Delete sessions older than the cutoff date.
   *
   * Protected sessions (should NOT be deleted):
   * - Scheduled for retry (next_attempt_at IS NOT NULL)
   *
   * @returns Number of sessions deleted
   */
  deleteOldSessions(cutoffDate: Date): Promise<number>;

  /**
   * Enforce maximum sessions per user by deleting oldest.
   *
   * Protected sessions (should NOT be deleted):
   * - Very recent activity
   * - Scheduled for retry
   *
   * @returns Number of sessions deleted
   */
  enforceMaxCountPerUser(maxCount: number): Promise<number>;
}
