import type { SessionState, Message, CheckpointMetadata } from '../domain/types';

export type HydrationOptions = {
  maxSessions?: number;
  maxMessages?: number;
  maxArtifacts?: number;
  maxCheckpoints?: number;
  recentMs?: number;
};

export interface SessionExecutionCoordinationFacts {
  sessionId: string;
  completed: boolean;
  blockedReason: string | null;
  nextAttemptAt: Date | null;
  executionClaimToken: string | null;
  executionClaimExpiresAt: Date | null;
}

export interface SessionRepositoryPort {
  hydrateAll(options?: HydrationOptions): Promise<SessionState[]>;
  hydrateSession?(sessionId: string, options?: HydrationOptions): Promise<SessionState | undefined>;
  findById?(sessionId: string): Promise<unknown>;
  persistSession(session: SessionState, isNew: boolean): Promise<void>;
  persistMetadata?(session: SessionState): Promise<void>;
  persistMessage?(sessionId: string, message: Message): Promise<void>;
  persistCheckpoint?(sessionId: string, metadata: CheckpointMetadata): Promise<void>;
  deleteSession?(sessionId: string): Promise<void>;
  countByUserId?(userId: string): Promise<number>;
  touchLastActive?(sessionId: string, timestamp?: Date): Promise<void>;
  getExecutionCoordinationFacts?(
    sessionId: string,
  ): Promise<SessionExecutionCoordinationFacts | null>;
  getExecutionCoordinationFactsMany?(
    sessionIds: readonly string[],
  ): Promise<SessionExecutionCoordinationFacts[]>;

  /**
   * Persist a blocked reason without mutating retry scheduling state.
   */
  setBlockedReason?(
    sessionId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): Promise<boolean>;

}
