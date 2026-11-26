import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  agentSessions,
  runPhases,
  runs,
  type AgentSessionRow,
  type NewAgentSessionRow,
} from '@/db/schema';
import type { SessionExecutionCoordinationFacts } from '../../ports/sessionRepository';

export type ClaimedSessionRecovery = {
  session: AgentSessionRow;
  interruptedTurn: boolean;
};

export type SessionUpdateFields = Partial<
  Omit<
    NewAgentSessionRow,
    | 'id'
    | 'createdAt'
  >
>;

export type PhaseSessionRoutingRow = {
  id: string;
  runId: string;
  phaseKey: string;
  status: string;
  sessionId: string | null;
  ordinal: number | null;
};

export type PhaseSessionRouting = {
  current: PhaseSessionRoutingRow | null;
  active: PhaseSessionRoutingRow | null;
};

export class SessionRepository {
  private static metadataMarksSessionCompleted(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }
    const flags = (metadata as Record<string, unknown>).flags;
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) {
      return false;
    }
    const session = (flags as Record<string, unknown>).session;
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      return false;
    }
    const completed = (session as Record<string, unknown>).completed;
    return completed === true || completed === 'true';
  }

  constructor(private readonly database = db) { }

  async create(values: NewAgentSessionRow): Promise<AgentSessionRow> {
    const [row] = await this.database.insert(agentSessions).values(values).returning();
    if (!row) {
      throw new Error('Failed to insert session');
    }
    return row;
  }

  async findById(id: string): Promise<AgentSessionRow | null> {
    const [row] = await this.database.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
    return row ?? null;
  }

  async listRecent(limit: number = 100): Promise<AgentSessionRow[]> {
    return this.database
      .select()
      .from(agentSessions)
      .orderBy(desc(agentSessions.lastActiveAt))
      .limit(limit);
  }

  async listAll(): Promise<AgentSessionRow[]> {
    return this.database.select().from(agentSessions);
  }

  async listIdsByRunId(runId: string): Promise<string[]> {
    if (!runId?.trim()) {
      return [];
    }

    const [flagRows, phaseRows] = await Promise.all([
      this.database
      .select({ id: agentSessions.id })
      .from(agentSessions)
        .where(sql`(${agentSessions.metadata} -> 'flags' -> 'securityops' ->> 'runId') = ${runId.trim()}`),
      this.database
        .select({ id: runPhases.sessionId })
        .from(runPhases)
        .where(eq(runPhases.runId, runId.trim())),
    ]);

    return Array.from(
      new Set(
        [...flagRows, ...phaseRows]
          .map((row) => row.id)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    );
  }

  async getExecutionCoordinationFacts(
    sessionId: string,
  ): Promise<SessionExecutionCoordinationFacts | null> {
    const rows = await this.getExecutionCoordinationFactsMany([sessionId]);
    return rows[0] ?? null;
  }

  async getExecutionCoordinationFactsMany(
    sessionIds: readonly string[],
  ): Promise<SessionExecutionCoordinationFacts[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.database
      .select({
        sessionId: agentSessions.id,
        completed: agentSessions.completed,
        blockedReason: agentSessions.blockedReason,
        nextAttemptAt: agentSessions.nextAttemptAt,
        executionClaimToken: agentSessions.executionClaimToken,
        executionClaimExpiresAt: agentSessions.executionClaimExpiresAt,
        metadata: agentSessions.metadata,
      })
      .from(agentSessions)
      .where(inArray(agentSessions.id, [...new Set(sessionIds)]));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      completed: row.completed || SessionRepository.metadataMarksSessionCompleted(row.metadata),
      blockedReason: row.blockedReason ?? null,
      nextAttemptAt: row.nextAttemptAt ?? null,
      executionClaimToken: row.executionClaimToken ?? null,
      executionClaimExpiresAt: row.executionClaimExpiresAt ?? null,
    }));
  }

  async findRunLifecycleStatus(runId: string): Promise<string | null> {
    if (!runId?.trim()) {
      return null;
    }

    const [row] = await this.database
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId.trim()))
      .limit(1);

    return row?.status ?? null;
  }

  async findPhaseSessionRouting(sessionId: string): Promise<PhaseSessionRouting | null> {
    if (!sessionId?.trim()) {
      return null;
    }

    const [current] = await this.database
      .select({
        id: runPhases.id,
        runId: runPhases.runId,
        phaseKey: runPhases.phaseKey,
        status: runPhases.status,
        sessionId: runPhases.sessionId,
        ordinal: runPhases.ordinal,
      })
      .from(runPhases)
      .where(eq(runPhases.sessionId, sessionId.trim()))
      .orderBy(desc(runPhases.ordinal))
      .limit(1);

    if (!current) {
      return null;
    }

    const [active] = await this.database
      .select({
        id: runPhases.id,
        runId: runPhases.runId,
        phaseKey: runPhases.phaseKey,
        status: runPhases.status,
        sessionId: runPhases.sessionId,
        ordinal: runPhases.ordinal,
      })
      .from(runPhases)
      .where(
        and(
          eq(runPhases.runId, current.runId),
          eq(runPhases.phaseKey, current.phaseKey),
          eq(runPhases.status, 'active'),
        ),
      )
      .orderBy(desc(runPhases.ordinal))
      .limit(1);

    return {
      current,
      active: active ?? null,
    };
  }

  async listChildSessionIds(parentSessionId: string): Promise<string[]> {
    if (!parentSessionId?.trim()) {
      return [];
    }

    const rows = await this.database
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(sql`(${agentSessions.metadata} -> 'coordination' ->> 'parentSessionId') = ${parentSessionId.trim()}`);

    return rows.map((row) => row.id);
  }

  async update(
    id: string,
    fields: SessionUpdateFields = {},
    options?: { expectedVersion?: number },
  ): Promise<void> {
    if (!id) {
      throw new Error('session id is required');
    }
    const nextFields: SessionUpdateFields = {
      ...fields,
      updatedAt: fields.updatedAt ?? new Date(),
    };
    const whereClause =
      typeof options?.expectedVersion === 'number'
        ? sql`${agentSessions.id} = ${id} AND COALESCE((( ${agentSessions.metadata} ->> 'version')::bigint), 0) = ${options.expectedVersion}`
        : eq(agentSessions.id, id);
    const result = await this.database
      .update(agentSessions)
      .set(nextFields)
      .where(whereClause)
      .returning({ id: agentSessions.id });
    if (typeof options?.expectedVersion === 'number' && result.length === 0) {
      const err = new Error('session_version_conflict') as Error & { code?: string; status?: number };
      err.code = 'session.conflict';
      err.status = 409;
      throw err;
    }
  }

  async touchLastActive(id: string, timestamp: Date = new Date()): Promise<void> {
    await this.update(id, { lastActiveAt: timestamp });
  }

  async acquireExecutionClaim(params: {
    sessionId: string;
    claimToken: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const now = new Date();
    const rows = await this.database
      .update(agentSessions)
      .set({
        executionClaimToken: params.claimToken,
        executionClaimExpiresAt: params.expiresAt,
        updatedAt: now,
      })
      .where(and(
        eq(agentSessions.id, params.sessionId),
        eq(agentSessions.completed, false),
        sql`(${agentSessions.executionClaimToken} IS NULL OR ${agentSessions.executionClaimExpiresAt} IS NULL OR ${agentSessions.executionClaimExpiresAt} < ${now})`,
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  async renewExecutionClaim(params: {
    sessionId: string;
    claimToken: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentSessions)
      .set({ executionClaimExpiresAt: params.expiresAt, updatedAt: new Date() })
      .where(and(
        eq(agentSessions.id, params.sessionId),
        eq(agentSessions.executionClaimToken, params.claimToken),
        eq(agentSessions.completed, false),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  async ownsExecutionClaim(sessionId: string, claimToken: string): Promise<boolean> {
    const now = new Date();
    const [row] = await this.database
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.executionClaimToken, claimToken),
        sql`${agentSessions.executionClaimExpiresAt} > ${now}`,
      ))
      .limit(1);
    return Boolean(row);
  }

  async releaseExecutionClaim(sessionId: string, claimToken: string): Promise<boolean> {
    const rows = await this.database
      .update(agentSessions)
      .set({ executionClaimToken: null, executionClaimExpiresAt: null, updatedAt: new Date() })
      .where(and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.executionClaimToken, claimToken),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  async claimDueRecovery(params: {
    claimToken: string;
    expiresAt: Date;
  }): Promise<ClaimedSessionRecovery | null> {
    const now = new Date();
    return this.database.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH candidate AS (
          SELECT
            session.id,
            (
              session.execution_claim_token IS NOT NULL
              AND session.execution_claim_expires_at IS NOT NULL
              AND session.execution_claim_expires_at < ${now}
            ) AS interrupted_turn
          FROM agent_sessions AS session
          WHERE session.completed = false
            AND COALESCE(session.metadata #>> '{flags,session,completed}', 'false') <> 'true'
            AND (
              (
                session.next_attempt_at IS NOT NULL
                AND session.next_attempt_at <= ${now}
                AND (
                  session.execution_claim_token IS NULL
                  OR session.execution_claim_expires_at IS NULL
                  OR session.execution_claim_expires_at < ${now}
                )
              )
              OR (
                session.mode = 'automated'
                AND
                session.execution_claim_token IS NOT NULL
                AND session.execution_claim_expires_at IS NOT NULL
                AND session.execution_claim_expires_at < ${now}
              )
            )
          ORDER BY COALESCE(session.next_attempt_at, session.execution_claim_expires_at), session.updated_at
          LIMIT 1
          FOR UPDATE OF session SKIP LOCKED
        )
        UPDATE agent_sessions AS session
        SET execution_claim_token = ${params.claimToken},
            execution_claim_expires_at = ${params.expiresAt},
            next_attempt_at = COALESCE(session.next_attempt_at, ${now}),
            updated_at = ${now}
        FROM candidate
        WHERE session.id = candidate.id
        RETURNING session.id, candidate.interrupted_turn
      `);
      const claimed = ((result as unknown as {
        rows?: Array<{ id?: unknown; interrupted_turn?: unknown }>;
      }).rows ?? [])[0];
      if (typeof claimed?.id !== 'string') return null;
      const [session] = await tx.select().from(agentSessions).where(eq(agentSessions.id, claimed.id)).limit(1);
      if (!session) return null;
      return { session, interruptedTurn: claimed.interrupted_turn === true };
    });
  }

  /**
   * Enter journal-derived continuation using only lease ownership. Recovery
   * action and attempt counters are deliberately not semantic preconditions.
   */
  async beginClaimedContinuation(params: {
    sessionId: string;
    claimToken: string;
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentSessions)
      .set({
        blockedReason: null,
        metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta'`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, params.sessionId),
        eq(agentSessions.executionClaimToken, params.claimToken),
        eq(agentSessions.completed, false),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  /**
   * Clear only the due projection that this worker claimed. A newer deferred
   * event changes `next_attempt_at`, so this compare-and-set cannot erase it.
   */
  async acknowledgeClaimedContinuation(params: {
    sessionId: string;
    claimToken: string;
    claimedDueAt: Date;
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentSessions)
      .set({
        nextAttemptAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, params.sessionId),
        eq(agentSessions.executionClaimToken, params.claimToken),
        eq(agentSessions.nextAttemptAt, params.claimedDueAt),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  async deferClaimedContinuation(params: {
    sessionId: string;
    claimToken: string;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentSessions)
      .set({
        nextAttemptAt: params.nextAttemptAt,
        executionClaimToken: null,
        executionClaimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, params.sessionId),
        eq(agentSessions.executionClaimToken, params.claimToken),
      ))
      .returning({ id: agentSessions.id });
    return rows.length > 0;
  }

  async delete(id: string): Promise<void> {
    await this.database.delete(agentSessions).where(eq(agentSessions.id, id));
  }

  async countByUserId(userId: string): Promise<number> {
    const [result] = await this.database
      .select({ count: sql<number>`count(*)` })
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId));
    return Number(result?.count ?? 0);
  }

  async listByUser(
    userId: string,
    options?: { limit?: number; offset?: number; status?: string },
  ): Promise<AgentSessionRow[]> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const query = this.database
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.userId, userId))
      .orderBy(desc(agentSessions.lastActiveAt))
      .limit(limit)
      .offset(offset);

    // Note: status filter removed - runtime state is derived at read time.
    const rows = await query;
    return rows;
  }

  /**
   * Read session runtime state in a single query for consistent reconciliation snapshots.
   */
  async getRuntimeSnapshot(id: string): Promise<{
    completed: boolean;
    blockedReason: string | null;
    hasPendingApproval: boolean;
    lastActiveAt: Date | null;
    currentTurn: number | null;
    blockedMeta: Record<string, unknown> | null;
  } | null> {
    const [row] = await this.database
      .select({
        completed: agentSessions.completed,
        blockedReason: agentSessions.blockedReason,
        metadata: agentSessions.metadata,
        lastActiveAt: agentSessions.lastActiveAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);

    if (!row) return null;

    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const hasPendingApproval =
      typeof metadata.pendingApproval === 'object' &&
      metadata.pendingApproval !== null;
    const currentTurn = typeof metadata.turn === 'number' && Number.isFinite(metadata.turn)
      ? Math.floor(metadata.turn)
      : null;
    const blockedMeta = typeof metadata.blockedMeta === 'object' && metadata.blockedMeta !== null && !Array.isArray(metadata.blockedMeta)
      ? metadata.blockedMeta as Record<string, unknown>
      : null;

    const completed =
      (row.completed ?? false) ||
      SessionRepository.metadataMarksSessionCompleted(metadata);

    return {
      completed,
      blockedReason: completed ? null : row.blockedReason ?? null,
      hasPendingApproval,
      lastActiveAt: row.lastActiveAt ?? null,
      currentTurn,
      blockedMeta,
    };
  }

  // ============================================================================
  // Blocked Reason Helpers (credits durability - Phase 3)
  // ============================================================================

  /**
   * Set blocked reason without scheduling a retry.
   * Used for credits_exhausted where user action is required.
   * 
   * @param id Session ID
   * @param reason Block reason (e.g., 'credits_exhausted')
   * @param meta Optional metadata (resetAt, requiredCredits, etc.)
   */
  async setBlockedReason(
    id: string,
    reason: string,
    meta?: Record<string, unknown>,
    executionClaimToken?: string,
  ): Promise<boolean> {
    const result = await this.database
      .update(agentSessions)
      .set({
        blockedReason: reason,
        // Store meta in existing metadata column if provided
        // NOTE: status is derived at read time, not written here
        ...(meta && { metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ blockedMeta: meta })}::jsonb` }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, id),
        executionClaimToken
          ? eq(agentSessions.executionClaimToken, executionClaimToken)
          : undefined,
      ))
      .returning({ id: agentSessions.id });
    
    return result.length > 0;
  }

  async setBlockedReasonIfClear(
    id: string,
    reason: string,
    meta?: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.database
      .update(agentSessions)
      .set({
        blockedReason: reason,
        ...(meta && { metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) || ${JSON.stringify({ blockedMeta: meta })}::jsonb` }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, id),
        eq(agentSessions.completed, false),
        isNull(agentSessions.blockedReason),
      ))
      .returning({ id: agentSessions.id });
    return result.length > 0;
  }

  /**
   * Clear blocked reason after successful resume.
   * Optionally only clears if reason matches expected (prevents race conditions).
   * 
   * @param id Session ID
   * @param expectedReason Only clear if current reason matches (optional)
   */
  async clearBlockedReason(
    id: string,
    expectedReason?: string,
    executionClaimToken?: string,
  ): Promise<boolean> {
    const whereClause = and(
      eq(agentSessions.id, id),
      expectedReason ? eq(agentSessions.blockedReason, expectedReason) : undefined,
      executionClaimToken
        ? eq(agentSessions.executionClaimToken, executionClaimToken)
        : undefined,
    );

    const result = await this.database
      .update(agentSessions)
      .set({
        blockedReason: null,
        metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta'`,
        // NOTE: status is derived at read time, not written here
        updatedAt: new Date(),
      })
      .where(whereClause)
      .returning({ id: agentSessions.id });
    
    return result.length > 0;
  }

  /**
   * Get current blocked reason for a session.
   */
  async getBlockedReason(id: string): Promise<string | null> {
    const rows = await this.database
      .select({ blockedReason: agentSessions.blockedReason })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    
    return rows[0]?.blockedReason ?? null;
  }

  /**
   * Update session title (for rename functionality).
   * 
   * @param id Session ID
   * @param title New title for the session
   */
  async updateTitle(id: string, title: string): Promise<boolean> {
    const result = await this.database
      .update(agentSessions)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(eq(agentSessions.id, id))
      .returning({ id: agentSessions.id });
    
    return result.length > 0;
  }

  /**
   * Set session completion status.
   * Used to prevent duplicate completion notifications.
   * 
   * @param id Session ID
   * @param completed Whether session has completed
   */
  async setCompleted(id: string, completed: boolean, executionClaimToken?: string): Promise<boolean> {
    const result = await this.database
      .update(agentSessions)
      .set({
        completed,
        ...(completed
          ? {
              nextAttemptAt: null,
              blockedReason: null,
              metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta'`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentSessions.id, id),
        executionClaimToken
          ? eq(agentSessions.executionClaimToken, executionClaimToken)
          : undefined,
      ))
      .returning({ id: agentSessions.id });
    
    return result.length > 0;
  }

  /**
   * Check if session is marked as completed.
   * Used to prevent duplicate completion notifications.
   * 
   * @param id Session ID
   */
  async getCompleted(id: string): Promise<boolean> {
    const rows = await this.database
      .select({ completed: agentSessions.completed })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1);
    
    return rows[0]?.completed ?? false;
  }
}

