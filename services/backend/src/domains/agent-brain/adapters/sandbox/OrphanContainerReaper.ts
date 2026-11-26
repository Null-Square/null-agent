/**
 * OrphanContainerReaper
 *
 * Cleans up orphan sandbox containers on backend startup and periodically.
 * Industry standard pattern: label-based discovery + reconciliation.
 *
 * Problem: When backend crashes/restarts, in-memory container tracking is lost.
 * Solution: Query Docker for containers with nullai.sandbox label, reconcile against
 *           active sessions, and remove containers without active sessions.
 *
 * Features:
 * - Startup cleanup (runs once on boot)
 * - Periodic cleanup (runs every N minutes, configurable)
 * - Prometheus metrics for observability
 * - Label-based container discovery
 */

import type { DockerDriver } from './DockerDriver';
import type { SessionRepository } from '../persistence';
import type { WorkspaceManager, WorkspaceOrphanCleanupResult, WorkspaceOwner } from '../../ports';
import { logger } from '@/shared/logger';
import { orphanContainerCleanupTotal, orphanContainerCleanupDuration } from '@/shared/metrics/prometheusMetrics';

const log = logger.child({ scope: 'OrphanContainerReaper' });

/** Label key used to identify NullAI sandbox containers */
export const SANDBOX_LABEL = 'nullai.sandbox';

/** Default cleanup interval: 5 minutes */
export const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export interface OrphanReaperResult {
  found: number;
  reaped: number;
  errors: number;
  reapedContainerIds: string[];
  workspacesFound: number;
  workspacesReaped: number;
  workspaceErrors: number;
  reapedWorkspaces: string[];
}

export interface OrphanReaperOptions {
  /** Cleanup interval in ms. Set to 0 to disable periodic cleanup. */
  intervalMs?: number;
  /** Optional workspace manager used to reclaim orphan ns-agent/ns-run workspace dirs. */
  workspaceManager?: WorkspaceManager;
  /** Minimum workspace age before orphan cleanup can delete it. */
  workspaceMinAgeMs?: number;
}

type ContainerOwner = { kind: 'session'; id: string } | { kind: 'run'; id: string };

type RunAwareSessionRepository = SessionRepository & {
  listIdsByRunId?: (runId: string) => Promise<string[]>;
  findRunLifecycleStatus?: (runId: string) => Promise<string | null>;
};

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export class OrphanContainerReaper {
  private intervalHandle?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    private readonly docker: DockerDriver,
    private readonly sessionRepository: RunAwareSessionRepository,
    private readonly options: OrphanReaperOptions = {},
  ) {}

  /**
   * Start periodic cleanup loop.
   * Safe to call multiple times (idempotent).
   */
  start(): void {
    const intervalMs = this.options.intervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

    if (intervalMs <= 0) {
      log.info('Periodic orphan cleanup disabled (intervalMs <= 0)');
      return;
    }

    if (this.intervalHandle) {
      log.debug('Periodic orphan cleanup already running');
      return;
    }

    log.info({ intervalMs }, 'Starting periodic orphan container cleanup');

    this.intervalHandle = setInterval(() => {
      void this.reapOrphans().catch((err) => {
        log.warn({ err }, 'Periodic orphan cleanup failed');
      });
    }, intervalMs);

    // Don't keep process alive just for this timer
    this.intervalHandle.unref?.();
  }

  /**
   * Stop periodic cleanup loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      log.info('Stopped periodic orphan container cleanup');
    }
  }

  /**
   * Reap orphan containers.
   *
   * Flow:
   * 1. Query Docker for all containers with nullai.sandbox=true label
   * 2. For each container, check if the associated session is still active
   * 3. If session is inactive or doesn't exist, destroy the container
   */
  async reapOrphans(): Promise<OrphanReaperResult> {
    // Prevent concurrent runs
    if (this.isRunning) {
      log.debug('Orphan cleanup already in progress, skipping');
      return {
        found: 0,
        reaped: 0,
        errors: 0,
        reapedContainerIds: [],
        workspacesFound: 0,
        workspacesReaped: 0,
        workspaceErrors: 0,
        reapedWorkspaces: [],
      };
    }

    this.isRunning = true;
    const startTime = Date.now();

    log.info('Starting orphan container cleanup...');

    const result: OrphanReaperResult = {
      found: 0,
      reaped: 0,
      errors: 0,
      reapedContainerIds: [],
      workspacesFound: 0,
      workspacesReaped: 0,
      workspaceErrors: 0,
      reapedWorkspaces: [],
    };

    try {
      // Find all containers with our sandbox label
      const containers = await this.docker.listByLabel(SANDBOX_LABEL, 'true');
      result.found = containers.length;

      // Record found count
      orphanContainerCleanupTotal.inc({ result: 'found' }, containers.length);

      if (containers.length === 0) {
        log.debug('No sandbox containers found');
      } else {
        log.info({ count: containers.length }, 'Found sandbox containers, checking for orphans');

        for (const container of containers) {
          const containerId = container.ID;
          const containerName = container.Names || 'unknown';

          // Labels are authoritative for admitted sandboxes and sidecars.
          // Names remain a compatibility fallback for legacy containers.
          const owner = await this.resolveContainerOwner(containerId, containerName);

          if (!owner) {
            log.warn({ containerId, containerName }, 'Could not extract sandbox owner from container name');
            continue;
          }

          // Check if the owner exists and is still active.
          const isActive = await this.isOwnerActive(owner);

          if (!isActive) {
            log.info({ containerId, owner }, 'Reaping orphan container (owner inactive or missing)');

            try {
              await this.docker.destroy(containerId);
              result.reaped++;
              result.reapedContainerIds.push(containerId);
              orphanContainerCleanupTotal.inc({ result: 'reaped' });
            } catch (error) {
              log.warn({ err: error, containerId }, 'Failed to destroy orphan container');
              result.errors++;
              orphanContainerCleanupTotal.inc({ result: 'error' });
            }
          } else {
            log.debug({ containerId, owner }, 'Container has active owner, keeping');
          }
        }
      }

      await this.reapWorkspaceOrphans(result);

      log.info(
        {
          found: result.found,
          reaped: result.reaped,
          errors: result.errors,
          workspacesFound: result.workspacesFound,
          workspacesReaped: result.workspacesReaped,
          workspaceErrors: result.workspaceErrors,
        },
        'Orphan container cleanup complete',
      );

      return result;
    } catch (error) {
      log.error({ err: error }, 'Failed to run orphan container cleanup');
      orphanContainerCleanupTotal.inc({ result: 'error' });
      await this.reapWorkspaceOrphans(result);
      return result;
    } finally {
      const durationMs = Date.now() - startTime;
      orphanContainerCleanupDuration.observe(durationMs);
      this.isRunning = false;
    }
  }

  /**
   * Extract sandbox owner from container name.
   * Expected formats: ns-agent-{sessionId}, ns-run-{runId}
   */
  private extractContainerOwner(containerName: string): ContainerOwner | undefined {
    // Handle array format from docker ps
    const name = Array.isArray(containerName) ? containerName[0] : containerName;
    const cleanName = name?.replace(/^\//, ''); // Remove leading slash

    const sessionPrefix = 'ns-agent-';
    if (cleanName?.startsWith(sessionPrefix)) {
      return { kind: 'session', id: cleanName.slice(sessionPrefix.length) };
    }

    const runPrefix = 'ns-run-';
    if (cleanName?.startsWith(runPrefix)) {
      return { kind: 'run', id: cleanName.slice(runPrefix.length) };
    }
    return undefined;
  }

  private async resolveContainerOwner(containerId: string, containerName: string): Promise<ContainerOwner | undefined> {
    try {
      const inspected = await this.docker.inspect(containerId);
      const config = this.readRecord(inspected)?.Config;
      const labels = this.readRecord(this.readRecord(config)?.Labels);
      const scope = labels?.['nullai.container-scope'];
      const runId = typeof labels?.['nullai.run-id'] === 'string' ? labels['nullai.run-id'].trim() : '';
      const sessionId = typeof labels?.['nullai.session-id'] === 'string' ? labels['nullai.session-id'].trim() : '';
      if (scope === 'run' && runId) return { kind: 'run', id: runId };
      if (sessionId) return { kind: 'session', id: sessionId };
      if (runId) return { kind: 'run', id: runId };
    } catch (error) {
      log.warn({ err: error, containerId }, 'Failed to inspect sandbox ownership labels; using legacy name fallback');
    }
    return this.extractContainerOwner(containerName);
  }

  private async isOwnerActive(owner: ContainerOwner): Promise<boolean> {
    if (owner.kind === 'session') {
      return this.isSessionActive(owner.id);
    }
    return this.isRunActive(owner.id);
  }

  /**
   * Check if a session is still active (not ended).
   */
  private async isSessionActive(sessionId: string): Promise<boolean> {
    try {
      const session = await this.sessionRepository.findById(sessionId);
      if (!session) {
        return false;
      }
      if (session.completed === true || this.metadataMarksSessionCompleted(session.metadata)) {
        return false;
      }
      if (session.blockedReason === 'aborted_by_user') {
        return false;
      }
      // An error classification is diagnostic metadata, not permission to destroy
      // restartable state. Only durable completion or explicit user cancellation
      // makes this owner inactive.
      return true;
    } catch (error) {
      // Preserve work if the durable model cannot be checked.
      log.warn({ err: error, sessionId }, 'Failed to check session activity; preserving sandbox owner');
      return true;
    }
  }

  /**
   * Check if a run-scoped container still has at least one active run session.
   */
  private async isRunActive(runId: string): Promise<boolean> {
    try {
      // A run-scoped sandbox belongs to the run lifecycle, not to whichever phase session
      // happens to be active at this instant. Between phase handoff and the next phase session,
      // every existing session can legitimately be complete while the run is still running.
      // Reaping in that gap races the next phase's attempt to adopt the shared container.
      if (typeof this.sessionRepository.findRunLifecycleStatus === 'function') {
        const runStatus = await this.sessionRepository.findRunLifecycleStatus(runId);
        if (typeof runStatus === 'string' && runStatus.length > 0) {
          return !TERMINAL_RUN_STATUSES.has(runStatus);
        }
      }

      if (typeof this.sessionRepository.listIdsByRunId !== 'function') {
        return true;
      }

      const sessionIds = await this.sessionRepository.listIdsByRunId(runId);
      for (const sessionId of sessionIds) {
        if (await this.isSessionActive(sessionId)) {
          return true;
        }
      }
      return false;
    } catch (error) {
      // Preserve work if the durable model cannot be checked.
      log.warn({ err: error, runId }, 'Failed to check run activity; preserving sandbox owner');
      return true;
    }
  }

  private metadataMarksSessionCompleted(metadata: unknown): boolean {
    const flags = this.readRecord(metadata)?.flags;
    const session = this.readRecord(flags)?.session;
    const completed = this.readRecord(session)?.completed;
    return completed === true || completed === 'true';
  }

  private readRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private async reapWorkspaceOrphans(result: OrphanReaperResult): Promise<void> {
    const workspaceManager = this.options.workspaceManager;
    if (typeof workspaceManager?.cleanupOrphanedWorkspaces !== 'function') {
      return;
    }

    let workspaceResult: WorkspaceOrphanCleanupResult;
    try {
      workspaceResult = await workspaceManager.cleanupOrphanedWorkspaces({
        minAgeMs: this.options.workspaceMinAgeMs,
        isOwnerActive: (owner: WorkspaceOwner) => this.isOwnerActive(owner),
      });
    } catch (error) {
      log.warn({ err: error }, 'Failed to reap orphan workspaces');
      result.workspaceErrors += 1;
      return;
    }

    result.workspacesFound = workspaceResult.found;
    result.workspacesReaped = workspaceResult.reaped;
    result.workspaceErrors = workspaceResult.errors;
    result.reapedWorkspaces = workspaceResult.reapedWorkspaces;
  }
}

/**
 * Run orphan container cleanup on startup.
 * Safe to call multiple times, idempotent.
 */
export async function reapOrphanContainersOnStartup(
  docker: DockerDriver,
  sessionRepository: SessionRepository,
  workspaceManager?: WorkspaceManager,
): Promise<OrphanReaperResult> {
  const reaper = new OrphanContainerReaper(docker, sessionRepository, {
    workspaceManager,
  });
  return reaper.reapOrphans();
}

/**
 * Create and start a periodic orphan reaper.
 * Returns the reaper instance for lifecycle management.
 */
export function startPeriodicOrphanReaper(
  docker: DockerDriver,
  sessionRepository: SessionRepository,
  intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS,
  workspaceManager?: WorkspaceManager,
): OrphanContainerReaper {
  const reaper = new OrphanContainerReaper(docker, sessionRepository, {
    intervalMs,
    workspaceManager,
  });
  reaper.start();
  return reaper;
}
