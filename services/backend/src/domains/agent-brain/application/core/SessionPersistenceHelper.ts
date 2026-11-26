/**
 * SessionPersistenceHelper
 *
 * Handles all persistence-related operations for SessionStore:
 * - Hydration from database
 * - Queuing persist operations (session, metadata, message, checkpoint)
 * - Serializing persistence to avoid race conditions
 * - Error handling with retry logic
 *
 * This is an internal helper class - SessionStore delegates to it.
 */

import type { Message, SessionState, CheckpointMetadata } from '../../domain/types';
import type { SessionRepositoryPort } from '../../ports';
import type { HydrationOptions } from '../../ports/sessionRepository';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { toLogSafeError, toSafeError } from '@/shared/errors';
import type { Logger } from 'pino';

export interface PersistenceContext {
  /** Map of session ID -> SessionState (the in-memory store) */
  sessions: Map<string, SessionState>;
  /** Set of session IDs that have been persisted to DB */
  persistedSessionIds: Set<string>;
  /** Session repository for DB operations */
  sessionRepository?: SessionRepositoryPort;
  /** Logger instance */
  logger: Logger;
  /** Callback for persist errors */
  onPersistError?: (info: {
    sessionId: string;
    stage: 'session' | 'metadata' | 'message' | 'checkpoint';
    error: Error;
    attempt?: number;
  }) => void;
  /** Hydration options */
  hydrationOptions?: HydrationOptions;
  /** Workspace manager for directory operations */
  workspaceManager?: {
    ensureWorkspace: (dir: string, ownerId?: string) => Promise<void>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const resolveWorkspaceOwnerId = (session: SessionState): string => {
  const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  return readString(securityops?.runId) ?? session.id;
};

export class SessionPersistenceHelper {
  private readonly sessionPersistPromises = new Map<string, Promise<void>>();
  private readonly metadataPersistPromises = new Map<string, Promise<void>>();
  private readonly messagePersistPromises = new Map<string, Promise<void>>();
  private readonly checkpointPersistPromises = new Map<string, Promise<void>>();
  private hydrationPromise?: Promise<void>;

  constructor(private readonly ctx: PersistenceContext) {}

  /**
   * Initialize hydration from database on startup.
   * Returns a promise that resolves when hydration is complete.
   */
  startHydration(): Promise<void> {
    if (!this.ctx.sessionRepository) {
      return Promise.resolve();
    }
    this.hydrationPromise = this.hydrateFromPersistence().catch((error) => {
      this.ctx.logger.error({ err: error }, '[SessionPersistenceHelper] Failed to hydrate from persistence');
    });
    return this.hydrationPromise;
  }

  /**
   * Wait for initial hydration to complete.
   */
  async whenReady(): Promise<void> {
    if (this.hydrationPromise) {
      await this.hydrationPromise;
    }
  }

  /**
   * Hydrate all sessions from persistence.
   */
  private async hydrateFromPersistence(): Promise<void> {
    const repo = this.ctx.sessionRepository;
    if (!repo) return;

    const started = Date.now();
    try {
      const sessions = await repo.hydrateAll(this.ctx.hydrationOptions);
      for (const session of sessions) {
        this.ctx.sessions.set(session.id, session);
        this.ctx.persistedSessionIds.add(session.id);
        if (this.ctx.workspaceManager) {
          await this.ctx.workspaceManager.ensureWorkspace(session.workspaceDir, resolveWorkspaceOwnerId(session));
        }
      }
      opsMetrics.recordSessionHydration(
        Date.now() - started,
        sessions.length,
        Boolean(this.ctx.hydrationOptions?.maxSessions)
      );
    } catch (error) {
      opsMetrics.recordSessionHydration(
        Date.now() - started,
        0,
        Boolean(this.ctx.hydrationOptions?.maxSessions),
        'error'
      );
      throw error;
    }
  }

  /**
   * Hydrate a single session on-demand if not in memory.
   */
  private readonly pendingHydrations = new Map<string, Promise<void>>();

  async hydrateIfMissing(sessionId: string): Promise<void> {
    const repo = this.ctx.sessionRepository;
    if (!repo?.hydrateSession) return;

    if (this.pendingHydrations.has(sessionId)) {
      await this.pendingHydrations.get(sessionId);
      return;
    }

    const hydratePromise = repo
      .hydrateSession(sessionId, this.ctx.hydrationOptions)
      .then(async (session) => {
        if (!session) {
          opsMetrics.recordSessionCache('miss', sessionId);
          return;
        }
        this.ctx.sessions.set(sessionId, session);
        this.ctx.persistedSessionIds.add(sessionId);
        if (this.ctx.workspaceManager) {
          await this.ctx.workspaceManager.ensureWorkspace(session.workspaceDir, resolveWorkspaceOwnerId(session));
        }
        opsMetrics.recordSessionCache('hit', sessionId);
      })
      .catch((error) => {
        opsMetrics.recordSessionCache('error', sessionId);
        this.ctx.logger.warn({ err: error, sessionId }, '[SessionPersistenceHelper] Failed to hydrate session on demand');
      })
      .finally(() => {
        this.pendingHydrations.delete(sessionId);
      });

    this.pendingHydrations.set(sessionId, hydratePromise);
    await hydratePromise;
  }

  /**
   * Queue session persistence (insert or update).
   */
  queuePersistSession(session: SessionState, options: { insert?: boolean } = {}): void {
    const repo = this.ctx.sessionRepository;
    if (!repo) return;

    const isNew = options.insert === true || !this.ctx.persistedSessionIds.has(session.id);
    this.serializePersist(
      this.sessionPersistPromises,
      session.id,
      async () => {
        await repo.persistSession(session, isNew);
        this.ctx.persistedSessionIds.add(session.id);
      },
      'session',
      (error) =>
        this.handlePersistError(session.id, error, {
          stage: 'session',
          retry: () => this.queuePersistSession(session, { ...options, insert: false }),
        })
    );
  }

  /**
   * Queue metadata-only persistence.
   */
  queuePersistMetadata(session: SessionState): void {
    const repo = this.ctx.sessionRepository;
    if (!repo) return;

    this.serializePersist(
      this.metadataPersistPromises,
      session.id,
      async () => {
        await repo.persistMetadata?.(session);
      },
      'metadata',
      (error) =>
        this.handlePersistError(session.id, error, {
          stage: 'metadata',
          retry: () => this.queuePersistMetadata(session),
        })
    );
  }

  /**
   * Queue message persistence.
   */
  queuePersistMessage(sessionId: string, message: Message): void {
    const repo = this.ctx.sessionRepository;
    if (!repo) return;

    this.serializePersist(
      this.messagePersistPromises,
      sessionId,
      async () => {
        // Wait for session to be persisted first
        try {
          await this.waitForSessionPersisted(sessionId);
        } catch {
          return; // Skip if session persistence failed
        }
        if (!this.ctx.persistedSessionIds.has(sessionId)) {
          this.ctx.logger.debug({ sessionId }, '[SessionPersistenceHelper] Skipping message persist - session not in DB yet');
          return;
        }
        await repo.persistMessage?.(sessionId, message);
      },
      'message'
    );
  }

  /**
   * Queue checkpoint persistence.
   */
  queuePersistCheckpoint(sessionId: string, metadata: CheckpointMetadata): void {
    const repo = this.ctx.sessionRepository;
    if (!repo) return;

    this.serializePersist(
      this.checkpointPersistPromises,
      sessionId,
      async () => {
        await this.waitForSessionPersisted(sessionId).catch(() => undefined);
        await repo.persistCheckpoint?.(sessionId, metadata);
      },
      'checkpoint'
    );
  }

  /**
   * Wait for a session's persist operation to complete.
   */
  async waitForSessionPersisted(sessionId: string): Promise<void> {
    const promise = this.sessionPersistPromises.get(sessionId);
    if (promise) {
      await promise;
    }
  }

  /**
   * Wait for queued metadata persistence for a session to complete.
   *
   * Metadata persistence has its own conflict recovery path and is used when a
   * lifecycle boundary must be durable before callers release runtime resources.
   */
  async waitForMetadataPersisted(sessionId: string): Promise<void> {
    const promise = this.metadataPersistPromises.get(sessionId);
    if (promise) {
      await promise;
    }
  }

  /**
   * Handle persistence errors with retry logic.
   */
  private async handlePersistError(
    sessionId: string,
    error: unknown,
    options: {
      retry?: () => void;
      attempt?: number;
      stage?: 'session' | 'metadata' | 'message' | 'checkpoint';
    } = {}
  ): Promise<void> {
    const safeError = toSafeError(error);
    const message = safeError.message;
    const attempt = options.attempt ?? 1;
    const maxAttempts = 2;
    const stage = options.stage ?? 'session';

    if (message === 'session_version_conflict' || message === 'session.conflict') {
      this.ctx.logger.debug({ sessionId, attempt, maxAttempts }, '[SessionPersistenceHelper] Version conflict; retrying');
      opsMetrics.recordSessionConflict(sessionId, 'persist', attempt, attempt < maxAttempts);
      if (attempt < maxAttempts) {
        const backoffMs = 50 * attempt;
        setTimeout(() => options.retry?.(), backoffMs);
      }
      this.ctx.onPersistError?.({ sessionId, error: safeError, attempt, stage });
      return;
    }

    this.ctx.onPersistError?.({ sessionId, error: safeError, attempt, stage });
    this.ctx.logger.error({ err: toLogSafeError(error), sessionId, stage }, '[SessionPersistenceHelper] Persist error');
  }

  /**
   * Serialize persistence operations to prevent race conditions.
   */
  private serializePersist(
    queue: Map<string, Promise<void>>,
    sessionId: string,
    work: () => Promise<void>,
    stage: 'session' | 'metadata' | 'message' | 'checkpoint',
    onError?: (error: Error) => void
  ): void {
    const previous = queue.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(work)
      .catch((error) => {
        const safeError = toSafeError(error);
        onError?.(safeError);
        this.ctx.onPersistError?.({ sessionId, error: safeError, stage });
      })
      .finally(() => {
        if (queue.get(sessionId) === next) {
          queue.delete(sessionId);
        }
      });
    queue.set(sessionId, next);
  }

  /**
   * Check if a session has been persisted to DB.
   */
  isPersisted(sessionId: string): boolean {
    return this.ctx.persistedSessionIds.has(sessionId);
  }

  /**
   * Mark a session as persisted (after direct persist).
   */
  markPersisted(sessionId: string): void {
    this.ctx.persistedSessionIds.add(sessionId);
  }

  /**
   * Remove a session from persisted tracking.
   */
  removePersisted(sessionId: string): void {
    this.ctx.persistedSessionIds.delete(sessionId);
  }
}
