import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { runEvents, runs, type RunRow } from '@/db/schema';

export class RunAdmissionQueue {
  constructor(
    private readonly db: DatabaseClient,
    private readonly claimTtlMs: number,
    private readonly planStarvationMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claimNext(owner: string): Promise<RunRow | null> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.claimTtlMs);
    const starvationCutoff = new Date(now.getTime() - this.planStarvationMs);
    return this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH oldest_per_org AS (
          SELECT id, organization_id, scheduling_class, queued_at,
            row_number() OVER (
              PARTITION BY organization_id
              ORDER BY COALESCE(eligible_at, queued_at, created_at), created_at
            ) AS org_rank
          FROM runs
          WHERE status = 'queued'
            AND execution_target = 'cloud'
            AND admitted_at IS NULL
            AND (not_before_at IS NULL OR not_before_at <= ${now})
            AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at < ${now})
        ), picked AS (
          SELECT run.id
          FROM runs AS run
          INNER JOIN oldest_per_org candidate ON candidate.id = run.id
          WHERE candidate.org_rank = 1
          ORDER BY
            CASE
              WHEN candidate.scheduling_class <> 'internal'
                AND COALESCE(candidate.queued_at, run.created_at) <= ${starvationCutoff} THEN 0
              WHEN candidate.scheduling_class = 'internal' THEN 1
              WHEN candidate.scheduling_class = 'pro' THEN 2
              WHEN candidate.scheduling_class = 'paid' THEN 3
              ELSE 4
            END,
            COALESCE(run.eligible_at, run.queued_at, run.created_at),
            run.created_at
          LIMIT 1
          FOR UPDATE OF run SKIP LOCKED
        )
        UPDATE runs AS run
        SET
          claim_owner = ${owner},
          claim_expires_at = ${expiresAt},
          admission_attempt_count = run.admission_attempt_count + 1,
          capacity_wait_reason = 'claiming',
          updated_at = ${now}
        FROM picked
        WHERE run.id = picked.id
          AND run.status = 'queued'
          AND run.execution_target = 'cloud'
          AND run.admitted_at IS NULL
          AND (run.not_before_at IS NULL OR run.not_before_at <= ${now})
          AND (run.claim_owner IS NULL OR run.claim_expires_at IS NULL OR run.claim_expires_at < ${now})
        RETURNING run.id
      `);
      const id = ((result as unknown as { rows?: Array<{ id?: unknown }> }).rows ?? [])[0]?.id;
      if (typeof id !== 'string') return null;
      const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      if (!row) return null;
      await tx.insert(runEvents).values({ runId: row.id, type: 'run.claimed', note: owner });
      return row;
    });
  }

  async defer(params: {
    runId: string;
    owner: string;
    reason: string;
    retryAt?: Date | null;
    permanent?: boolean;
  }): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(runs)
        .set({
          status: params.permanent ? 'failed' : 'queued',
          claimOwner: null,
          claimExpiresAt: null,
          admittedAt: null,
          runnerId: null,
          sessionId: null,
          plannerSessionId: null,
          executorSessionId: null,
          capacityWaitReason: params.reason,
          admissionLastError: params.permanent ? params.reason : null,
          notBeforeAt: params.permanent ? null : params.retryAt ?? null,
          completedAt: params.permanent ? now : null,
          updatedAt: now,
        })
        .where(and(eq(runs.id, params.runId), eq(runs.claimOwner, params.owner)))
        .returning({ id: runs.id });
      if (!updated) return;
      await tx.insert(runEvents).values({
        runId: params.runId,
        type: params.permanent ? 'run.admission_failed' : 'run.capacity_wait_reason_changed',
        note: params.reason,
      });
    });
  }

  /**
   * Keep ownership alive while an admitted Run is constructing its session and
   * workspace. Without this heartbeat, a slow but healthy launch can cross the
   * claim TTL and be reclaimed by the crash reconciler.
   */
  async renewClaim(runId: string, owner: string): Promise<boolean> {
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.claimTtlMs);
    const [updated] = await this.db
      .update(runs)
      .set({ claimExpiresAt: expiresAt, updatedAt: now })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.claimOwner, owner),
          inArray(runs.status, ['queued', 'running']),
        ),
      )
      .returning({ id: runs.id });
    return Boolean(updated);
  }

  async markStarted(params: { runId: string; owner: string; sessionId: string }): Promise<RunRow> {
    const now = this.now();
    const startedRun = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(runs)
        .set({
          status: 'running',
          sessionId: params.sessionId,
          claimOwner: null,
          claimExpiresAt: null,
          capacityWaitReason: null,
          epochStartedAt: now,
          startedAt: sql`COALESCE(${runs.startedAt}, ${now})`,
          updatedAt: now,
        })
        .where(
          and(
            eq(runs.id, params.runId),
            eq(runs.claimOwner, params.owner),
            inArray(runs.status, ['queued', 'running']),
          ),
        )
        .returning();
      if (!run) throw new Error('Run admission claim changed before kickoff');
      await tx.insert(runEvents).values({ runId: run.id, type: 'run.started' });
      return run;
    });
    // Analytics/notifications are idempotent side effects and must never make
    // a successfully committed admission look like a failed launch.
    return startedRun;
  }

  async clearExpiredClaims(limit = 100): Promise<number> {
    const now = this.now();
    const result = await this.db.execute(sql`
      WITH expired AS (
        SELECT id
        FROM runs
        WHERE status = 'queued'
          AND execution_target = 'cloud'
          AND admitted_at IS NULL
          AND claim_owner IS NOT NULL
          AND claim_expires_at < ${now}
        ORDER BY claim_expires_at
        LIMIT ${Math.max(1, Math.min(limit, 500))}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE runs AS run
      SET claim_owner = NULL,
          claim_expires_at = NULL,
          capacity_wait_reason = 'waiting_for_admission',
          updated_at = ${now}
      FROM expired
      WHERE run.id = expired.id
      RETURNING run.id
    `);
    return ((result as unknown as { rows?: unknown[] }).rows ?? []).length;
  }
}
