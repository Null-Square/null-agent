/**
 * SessionRetentionReaper - Simple DB-driven session cleanup
 *
 * REFACTORED (Jan 2026): Now uses SessionRetentionPort via dependency injection
 * instead of direct database access. This follows hexagonal architecture
 * principles - core domain logic is infrastructure-agnostic.
 *
 * Gemini-style retention: delete old sessions without complex lifecycle states.
 *
 * Safety rules:
 * - Never delete sessions with very recent activity
 * - Never delete sessions scheduled for retry
 * - ON DELETE CASCADE handles messages/tool_execution_records
 *
 * @module agent-brain/core/services
 */

import { logger } from '@/shared/logger';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import type { SessionLifecycleConfigLayer } from '@/config/configTypes';
import { SESSION_RETENTION_INITIAL_DELAY_MS, SESSION_RETENTION_INTERVAL_MS } from '@/config/timeouts';
import type { SessionRetentionPort } from '../../ports';

const log = logger.child({ scope: 'SessionRetentionReaper' });

export class SessionRetentionReaper {
  private intervalHandle?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: SessionLifecycleConfigLayer,
    private readonly retentionPort: SessionRetentionPort,
  ) {}

  /**
   * Run one cleanup cycle. Returns number of sessions deleted.
   */
  async runOnce(): Promise<{ deletedCount: number; errors: string[] }> {
    if (!this.config.retentionEnabled) {
      return { deletedCount: 0, errors: [] };
    }

    const startMs = Date.now();
    const errors: string[] = [];
    let deletedCount = 0;

    // 1. Delete sessions older than maxAgeDays (if set)
    if (this.config.maxAgeDays > 0) {
      try {
        const cutoffDate = new Date(Date.now() - this.config.maxAgeDays * 24 * 60 * 60 * 1000);
        const result = await this.retentionPort.deleteOldSessions(cutoffDate);
        deletedCount += result;
        if (result > 0) {
          log.info({ deletedCount: result, maxAgeDays: this.config.maxAgeDays }, 'Deleted old sessions');
        }
      } catch (err) {
        const msg = `Failed to delete old sessions: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err }, msg);
        errors.push(msg);
      }
    }

    // 2. Enforce maxCountPerUser (if set) - delete oldest beyond cap
    if (this.config.maxCountPerUser > 0) {
      try {
        const result = await this.retentionPort.enforceMaxCountPerUser(this.config.maxCountPerUser);
        deletedCount += result;
        if (result > 0) {
          log.info({ deletedCount: result, maxCount: this.config.maxCountPerUser }, 'Enforced max sessions per user');
        }
      } catch (err) {
        const msg = `Failed to enforce max count: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err }, msg);
        errors.push(msg);
      }
    }

    // Record metrics
    const endMs = Date.now() - startMs;
    opsMetrics.recordRetentionRun(endMs, deletedCount, errors.length > 0);

    return { deletedCount, errors };
  }

  /**
   * Start periodic cleanup. Runs every 6 hours by default.
   */
  start(intervalMs: number = SESSION_RETENTION_INTERVAL_MS): void {
    if (this.running) {
      log.warn('Retention reaper already running');
      return;
    }

    this.running = true;
    log.info({ intervalMs, config: this.config }, 'Starting session retention reaper');

    // Run once after a delay (let system stabilize)
    setTimeout(() => {
      if (this.running) {
        this.runOnce().catch(err => log.error({ err }, 'Retention reaper failed'));
      }
    }, SESSION_RETENTION_INITIAL_DELAY_MS);

    // Then run periodically
    this.intervalHandle = setInterval(() => {
      if (this.running) {
        this.runOnce().catch(err => log.error({ err }, 'Retention reaper failed'));
      }
    }, intervalMs);
  }

  /**
   * Stop the periodic cleanup.
   */
  stop(): void {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      log.info('Session retention reaper stopped');
    }
  }
}

// Re-export port type for convenience
export type { SessionRetentionPort } from '../../ports';
