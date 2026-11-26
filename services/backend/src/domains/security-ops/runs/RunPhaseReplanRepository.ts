import { and, eq, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  runPhaseReplans,
  type RunPhaseReplanRow,
} from '@/db/schema';
import type { RunPhaseStatus } from './PhaseProfileRegistry';

export type OpenPhaseReplanInput = {
  runId: string;
  phaseId: string;
  requestedPhaseStatus: Extract<RunPhaseStatus, 'completed' | 'blocked' | 'failed'>;
  handoffRef?: string | null;
  reason?: string | null;
};

export type OpenPhaseReplanResult = {
  row: RunPhaseReplanRow | null;
  created: boolean;
};

export class RunPhaseReplanRepository {
  constructor(private readonly db: DatabaseClient) {}

  async open(params: OpenPhaseReplanInput): Promise<OpenPhaseReplanResult> {
    const [created] = await this.db
      .insert(runPhaseReplans)
      .values({
        runId: params.runId,
        phaseId: params.phaseId,
        requestedPhaseStatus: params.requestedPhaseStatus,
        handoffRef: params.handoffRef ?? null,
        reason: params.reason ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      return { row: created, created: true };
    }

    const existing = await this.findOpen(params);
    return { row: existing, created: false };
  }

  async findOpen(params: { runId: string; phaseId: string }): Promise<RunPhaseReplanRow | null> {
    const [row] = await this.db
      .select()
      .from(runPhaseReplans)
      .where(
        and(
          eq(runPhaseReplans.runId, params.runId),
          eq(runPhaseReplans.phaseId, params.phaseId),
          eq(runPhaseReplans.status, 'open'),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  async hasOpen(params: { runId: string; phaseId: string }): Promise<boolean> {
    return Boolean(await this.findOpen(params));
  }

  async claimDue(params: { claimToken: string; expiresAt: Date }): Promise<RunPhaseReplanRow | null> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM run_phase_replans
          WHERE status = 'open'
            AND next_attempt_at <= ${now}
            AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ${now})
          ORDER BY next_attempt_at, requested_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE run_phase_replans AS replan
        SET claim_token = ${params.claimToken},
            claim_expires_at = ${params.expiresAt},
            dispatch_attempts = replan.dispatch_attempts + 1,
            last_dispatch_at = ${now},
            updated_at = ${now}
        FROM candidate
        WHERE replan.id = candidate.id
        RETURNING replan.id
      `);
      const id = ((result as unknown as { rows?: Array<{ id?: unknown }> }).rows ?? [])[0]?.id;
      if (typeof id !== 'string') return null;
      const [row] = await tx.select().from(runPhaseReplans).where(eq(runPhaseReplans.id, id)).limit(1);
      return row ?? null;
    });
  }

  async releaseClaim(replanId: string, claimToken: string): Promise<boolean> {
    const rows = await this.db
      .update(runPhaseReplans)
      .set({ claimToken: null, claimExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(runPhaseReplans.id, replanId), eq(runPhaseReplans.claimToken, claimToken)))
      .returning({ id: runPhaseReplans.id });
    return rows.length > 0;
  }

  async renewClaim(params: {
    replanId: string;
    claimToken: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .update(runPhaseReplans)
      .set({ claimExpiresAt: params.expiresAt, updatedAt: new Date() })
      .where(and(
        eq(runPhaseReplans.id, params.replanId),
        eq(runPhaseReplans.status, 'open'),
        eq(runPhaseReplans.claimToken, params.claimToken),
      ))
      .returning({ id: runPhaseReplans.id });
    return rows.length > 0;
  }

  async scheduleClaimedRetry(params: {
    replanId: string;
    claimToken: string;
    nextAttemptAt: Date;
    error: string;
  }): Promise<boolean> {
    const rows = await this.db
      .update(runPhaseReplans)
      .set({
        nextAttemptAt: params.nextAttemptAt,
        lastDispatchError: params.error.slice(0, 2_000),
        updatedAt: new Date(),
      })
      .where(and(
        eq(runPhaseReplans.id, params.replanId),
        eq(runPhaseReplans.status, 'open'),
        eq(runPhaseReplans.claimToken, params.claimToken),
      ))
      .returning({ id: runPhaseReplans.id });
    return rows.length > 0;
  }

  async deferClaimWithoutAttempt(params: {
    replanId: string;
    claimToken: string;
    nextAttemptAt: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .update(runPhaseReplans)
      .set({
        nextAttemptAt: params.nextAttemptAt,
        dispatchAttempts: sql`GREATEST(0, ${runPhaseReplans.dispatchAttempts} - 1)`,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(runPhaseReplans.id, params.replanId),
        eq(runPhaseReplans.status, 'open'),
        eq(runPhaseReplans.claimToken, params.claimToken),
      ))
      .returning({ id: runPhaseReplans.id });
    return rows.length > 0;
  }

  async failClaimed(params: { replanId: string; claimToken: string; error: string }): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .update(runPhaseReplans)
      .set({
        status: 'failed',
        lastDispatchError: params.error.slice(0, 2_000),
        claimToken: null,
        claimExpiresAt: null,
        closedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(runPhaseReplans.id, params.replanId),
        eq(runPhaseReplans.status, 'open'),
        eq(runPhaseReplans.claimToken, params.claimToken),
      ))
      .returning({ id: runPhaseReplans.id });
    return rows.length > 0;
  }

  async hasApplied(params: { runId: string; phaseId: string }): Promise<boolean> {
    const [row] = await this.db
      .select({ id: runPhaseReplans.id })
      .from(runPhaseReplans)
      .where(
        and(
          eq(runPhaseReplans.runId, params.runId),
          eq(runPhaseReplans.phaseId, params.phaseId),
          eq(runPhaseReplans.status, 'applied'),
        ),
      )
      .limit(1);

    return Boolean(row);
  }

  async markOpenForRunApplied(runId: string): Promise<number> {
    const now = new Date();
    const rows = await this.db
      .update(runPhaseReplans)
      .set({
        status: 'applied',
        appliedAt: now,
        closedAt: now,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: now,
      })
      .where(and(eq(runPhaseReplans.runId, runId), eq(runPhaseReplans.status, 'open')))
      .returning({ id: runPhaseReplans.id });

    return rows.length;
  }

}
