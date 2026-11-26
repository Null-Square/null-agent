import type { SessionEventDraft, SessionEventRecord } from '../domain/session-journal';

export interface AppendSessionEventsInput {
  sessionId: string;
  expectedSequence: number;
  events: SessionEventDraft[];
  /** Transactional, rebuildable wake-up projection for the continuation coordinator. */
  coordination?: {
    nextAttemptAt: Date | null;
    /** Preserve an existing prerequisite/backoff schedule when closing a turn. */
    updateMode?: 'replace' | 'if_missing';
    /** Start reopens the rebuildable completion projection atomically. */
    reopenSession?: boolean;
    /** Closeout completion updates the rebuildable completion projection atomically. */
    completeSession?: boolean;
    /** Rebuildable UI/compatibility projection committed with Stop or Start. */
    blockedReason?: string | null;
    blockedMeta?: Record<string, unknown>;
    /** Stop revokes any in-flight writer in the same transaction as intent. */
    revokeExecutionClaim?: boolean;
    /** Fence semantic completion to the worker that still owns execution. */
    expectedExecutionClaimToken?: string;
  };
}

export class SessionJournalConflictError extends Error {
  readonly code = 'session_journal.conflict';

  constructor(
    readonly sessionId: string,
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(
      `Session journal conflict for ${sessionId}: expected sequence ${expectedSequence}, actual ${actualSequence}.`,
    );
    this.name = 'SessionJournalConflictError';
  }
}

export class SessionJournalIdempotencyError extends Error {
  readonly code = 'session_journal.idempotency_conflict';

  constructor(readonly eventId: string, detail: string) {
    super(`Session journal event ${eventId} cannot be replayed idempotently: ${detail}.`);
    this.name = 'SessionJournalIdempotencyError';
  }
}

export interface SessionEventJournalPort {
  append(input: AppendSessionEventsInput): Promise<SessionEventRecord[]>;
  load(sessionId: string): Promise<SessionEventRecord[]>;
  loadMany?(sessionIds: readonly string[]): Promise<SessionEventRecord[]>;
  loadAfter(sessionId: string, sequence: number): Promise<SessionEventRecord[]>;
  lastSequence(sessionId: string): Promise<number>;
}
