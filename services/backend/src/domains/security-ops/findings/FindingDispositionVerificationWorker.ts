import { and, asc, eq, inArray, lt, lte, ne, sql } from 'drizzle-orm';

import type { AgentApiServices } from '@/app/services/agent/types';
import type { DatabaseClient } from '@/db/client';
import {
  findingDispositionVerifications,
  findingEvents,
  findings,
  organizationMembers,
  runs,
  type FindingDispositionVerificationRow,
} from '@/db/schema';
import type { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { parseExperienceProfile } from '@/domains/platform/subscriptions/experienceProfile';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';
import { RUN_ACTIVE_STATUSES } from '@/domains/security-ops/runs/RunLifecycleHelpers';
import type { RunService } from '@/domains/security-ops/runs/RunService';
import type { StartRunService } from '@/domains/security-ops/runs/StartRunService';
import { schedulingClassForPlan } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';
import { roleHasCapability } from '@/shared/auth/capabilities';
import { normalizeOrgRole } from '@/shared/auth/orgRoles';
import { AppError, ERROR_CODES, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

const ACTIVE_VERIFICATION_STATUSES = ['queued', 'waiting', 'launching', 'running'] as const;
const LAUNCH_QUEUE_STATUSES = ['queued', 'waiting', 'launching'] as const;
const RUN_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 5;

export type FindingDispositionWorkerHealth = {
  startedAt: string | null;
  lastSweepStartedAt: string | null;
  lastSuccessfulSweepAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  oldestDueAgeMs: number | null;
  activeQueueDepth: number;
  inFlight: boolean;
};

type WorkerDeps = {
  db: DatabaseClient;
  startRunService: Pick<StartRunService, 'startFindingDispositionVerificationRun'>;
  runService: Pick<
    RunService,
    'cancel' | 'getByIdempotencyKey' | 'getScopeConcurrencyLimit'
  >;
  agentServices: AgentApiServices;
  sessionRepository: Pick<SessionRepository, 'listIdsByRunId' | 'setBlockedReason'>;
  accessControl?: Pick<AccessControlService, 'resolveOrganizationSubscription'>;
  workerId?: string;
  now?: () => Date;
  random?: () => number;
};

type ProcessOutcome = 'started' | 'waiting' | 'failed' | 'superseded' | 'repaired' | 'ignored';

const retryAt = (now: Date, delayMs: number): Date => new Date(now.getTime() + delayMs);

const errorContextReason = (error: AppError): string | null =>
  typeof error.context?.reason === 'string' ? error.context.reason : null;

export class FindingDispositionVerificationWorker {
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private sweepInFlight = false;
  readonly health: FindingDispositionWorkerHealth;

  constructor(private readonly deps: WorkerDeps) {
    this.workerId = deps.workerId ?? `finding-disposition:${process.pid}`;
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.health = {
      startedAt: this.now().toISOString(),
      lastSweepStartedAt: null,
      lastSuccessfulSweepAt: null,
      lastErrorAt: null,
      lastError: null,
      oldestDueAgeMs: null,
      activeQueueDepth: 0,
      inFlight: false,
    };
  }

  async sweep(limit = DEFAULT_BATCH_SIZE): Promise<{
    claimed: number;
    started: number;
    repaired: number;
    waiting: number;
    failed: number;
    superseded: number;
    ignored: number;
    reconciled: number;
  }> {
    if (this.sweepInFlight) {
      return {
        claimed: 0,
        started: 0,
        repaired: 0,
        waiting: 0,
        failed: 0,
        superseded: 0,
        ignored: 0,
        reconciled: 0,
      };
    }
    this.sweepInFlight = true;
    const sweepStartedAt = this.now();
    this.health.inFlight = true;
    this.health.lastSweepStartedAt = sweepStartedAt.toISOString();
    try {
      const reconciled = await this.reconcile(Math.max(10, limit * 4));
      const claimed = await this.claimDue(Math.max(1, Math.min(limit, 25)));
      const outcomes = await Promise.all(claimed.map((row) => this.processClaim(row)));
      const summary = {
        claimed: claimed.length,
        started: outcomes.filter((value) => value === 'started').length,
        repaired: outcomes.filter((value) => value === 'repaired').length,
        waiting: outcomes.filter((value) => value === 'waiting').length,
        failed: outcomes.filter((value) => value === 'failed').length,
        superseded: outcomes.filter((value) => value === 'superseded').length,
        ignored: outcomes.filter((value) => value === 'ignored').length,
        reconciled,
      };
      await this.refreshHealth();
      this.health.lastSuccessfulSweepAt = this.now().toISOString();
      this.health.lastError = null;
      const logLevel = summary.claimed > 0 || summary.reconciled > 0 ? 'info' : 'debug';
      logger[logLevel]({
        workerId: this.workerId,
        durationMs: Math.max(0, this.now().getTime() - sweepStartedAt.getTime()),
        ...summary,
        activeQueueDepth: this.health.activeQueueDepth,
        oldestDueAgeMs: this.health.oldestDueAgeMs,
      }, '[FindingDispositionWorker] Sweep completed');
      return summary;
    } catch (error) {
      const err = toAppError(error);
      this.health.lastErrorAt = this.now().toISOString();
      this.health.lastError = err.message.slice(0, 1_000);
      logger.error({
        err,
        workerId: this.workerId,
        durationMs: Math.max(0, this.now().getTime() - sweepStartedAt.getTime()),
      }, '[FindingDispositionWorker] Sweep failed');
      throw error;
    } finally {
      this.sweepInFlight = false;
      this.health.inFlight = false;
    }
  }

  private async refreshHealth(): Promise<void> {
    const [row] = await this.deps.db
      .select({
        count: sql<number>`count(*)::int`,
        oldestDueAgeMs: sql<number | null>`
          EXTRACT(
            EPOCH FROM (
              now() - min(
                CASE
                  WHEN ${findingDispositionVerifications.status} IN ('queued', 'waiting')
                    AND ${findingDispositionVerifications.nextAttemptAt} <= now()
                    THEN ${findingDispositionVerifications.nextAttemptAt}
                  WHEN ${findingDispositionVerifications.status} = 'launching'
                    AND ${findingDispositionVerifications.leaseExpiresAt} < now()
                    THEN ${findingDispositionVerifications.leaseExpiresAt}
                  ELSE NULL
                END
              )
            )
          ) * 1000
        `,
      })
      .from(findingDispositionVerifications)
      .where(inArray(findingDispositionVerifications.status, [...LAUNCH_QUEUE_STATUSES]));
    this.health.activeQueueDepth = Number(row?.count ?? 0);
    this.health.oldestDueAgeMs =
      row?.oldestDueAgeMs === null || row?.oldestDueAgeMs === undefined
        ? null
        : Math.max(0, Number(row.oldestDueAgeMs));
  }

  /**
   * Claim is a short PostgreSQL reservation transaction. Fair candidates are
   * limited per organization, then each scope is serialized by an advisory
   * lock while active Runs plus launching reservations are re-counted.
   */
  private async claimDue(limit: number): Promise<FindingDispositionVerificationRow[]> {
    return this.deps.db.transaction(async (tx) => {
      const now = this.now();
      const leaseExpiresAt = retryAt(now, LEASE_MS);
      const result = await tx.execute(sql`
        WITH ranked AS (
          SELECT
            id,
            row_number() OVER (
              PARTITION BY organization_id
              ORDER BY next_attempt_at ASC, created_at ASC
            ) AS organization_rank
          FROM finding_disposition_verifications
          WHERE (
            status IN ('queued', 'waiting')
            AND next_attempt_at <= now()
          ) OR (
            status = 'launching'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at < now()
          )
        )
        SELECT verification.id
        FROM finding_disposition_verifications AS verification
        INNER JOIN ranked ON ranked.id = verification.id
        WHERE ranked.organization_rank <= 2
        ORDER BY verification.next_attempt_at ASC, verification.created_at ASC
        LIMIT ${Math.max(limit * 4, 20)}
        FOR UPDATE OF verification SKIP LOCKED
      `);
      const candidateIds = ((result as unknown as { rows?: Array<{ id?: unknown }> }).rows ?? [])
        .map((row) => typeof row.id === 'string' ? row.id : null)
        .filter((id): id is string => Boolean(id));
      const claimed: FindingDispositionVerificationRow[] = [];

      for (const id of candidateIds) {
        if (claimed.length >= limit) break;
        const [row] = await tx
          .select()
          .from(findingDispositionVerifications)
          .where(eq(findingDispositionVerifications.id, id))
          .limit(1);
        if (!row) continue;

        // The candidate query and this read are separate statements. Another
        // worker can commit a fresh launch lease between them after both saw
        // the row as queued. Re-check eligibility after the row lock is ours;
        // otherwise this worker can steal that live lease and both launch the
        // same verification.
        const isDueQueueRow =
          (row.status === 'queued' || row.status === 'waiting')
          && row.nextAttemptAt.getTime() <= now.getTime();
        const isExpiredLaunch =
          row.status === 'launching'
          && row.leaseExpiresAt !== null
          && row.leaseExpiresAt.getTime() < now.getTime();
        if (!isDueQueueRow && !isExpiredLaunch) continue;

        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`finding-disposition-admission:${row.organizationId}:${row.scopeId}:pentest`},
              0
            )
          )
        `);
        const [[activeRuns], [reservedLaunches]] = await Promise.all([
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(runs)
            .where(
              and(
                eq(runs.organizationId, row.organizationId),
                eq(runs.scopeId, row.scopeId),
                eq(runs.workflowDiscipline, 'pentest'),
                inArray(runs.status, RUN_ACTIVE_STATUSES),
                row.runId ? ne(runs.id, row.runId) : undefined,
              ),
            ),
          tx
            .select({ count: sql<number>`count(*)::int` })
            .from(findingDispositionVerifications)
            .where(
              and(
                eq(findingDispositionVerifications.organizationId, row.organizationId),
                eq(findingDispositionVerifications.scopeId, row.scopeId),
                eq(findingDispositionVerifications.status, 'launching'),
                ne(findingDispositionVerifications.id, row.id),
              ),
            ),
        ]);
        const capacityUsed = Number(activeRuns?.count ?? 0) + Number(reservedLaunches?.count ?? 0);
        if (capacityUsed >= this.deps.runService.getScopeConcurrencyLimit()) {
          await tx
            .update(findingDispositionVerifications)
            .set({
              status: 'waiting',
              waitReason: 'scope_capacity',
              nextAttemptAt: retryAt(now, 30_000),
              updatedAt: now,
            })
            .where(eq(findingDispositionVerifications.id, row.id));
          continue;
        }

        const [updated] = await tx
          .update(findingDispositionVerifications)
          .set({
            status: 'launching',
            waitReason: null,
            failureCode: null,
            failureReason: null,
            leaseOwner: this.workerId,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(
            and(
              eq(findingDispositionVerifications.id, row.id),
              isExpiredLaunch
                ? and(
                    eq(findingDispositionVerifications.status, 'launching'),
                    lt(findingDispositionVerifications.leaseExpiresAt, now),
                  )
                : and(
                    inArray(findingDispositionVerifications.status, ['queued', 'waiting']),
                    lte(findingDispositionVerifications.nextAttemptAt, now),
                  ),
            ),
          )
          .returning();
        if (updated) claimed.push(updated);
      }
      return claimed;
    });
  }

  private async processClaim(
    claimed: FindingDispositionVerificationRow,
  ): Promise<ProcessOutcome> {
    const [verification] = await this.deps.db
      .select()
      .from(findingDispositionVerifications)
      .where(eq(findingDispositionVerifications.id, claimed.id))
      .limit(1);
    if (
      !verification
      || verification.status !== 'launching'
      || verification.leaseOwner !== this.workerId
    ) {
      return 'ignored';
    }

    const [[finding], [membership]] = await Promise.all([
      this.deps.db
        .select({
          lifecycleVersion: findings.lifecycleVersion,
          scopeId: findings.scopeId,
        })
        .from(findings)
        .where(
          and(
            eq(findings.id, verification.findingId),
            eq(findings.organizationId, verification.organizationId),
          ),
        )
        .limit(1),
      this.deps.db
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.organizationId, verification.organizationId),
            eq(organizationMembers.userId, verification.requestedByUserId),
          ),
        )
        .limit(1),
    ]);
    if (!finding || finding.scopeId !== verification.scopeId) {
      await this.markTerminal(verification, 'superseded', 'finding_or_scope_removed', 'Finding or scope no longer exists');
      return 'superseded';
    }
    if (finding.lifecycleVersion !== verification.findingLifecycleVersion) {
      await this.markTerminal(
        verification,
        'superseded',
        'finding_lifecycle_changed',
        'Finding status or validation changed after this request was created',
      );
      return 'superseded';
    }
    const role = normalizeOrgRole(membership?.role);
    if (!role || !roleHasCapability(role, 'findings.triage')) {
      await this.markTerminal(
        verification,
        'failed',
        'permission_revoked',
        'The requester no longer has finding-triage permission',
      );
      return 'failed';
    }

    const existingRun = await this.deps.runService.getByIdempotencyKey(
      verification.organizationId,
      verification.launchKey,
    );
    const launchCount = existingRun
      ? verification.launchAttemptCount
      : verification.launchAttemptCount + 1;
    if (!existingRun) {
      await this.deps.db
        .update(findingDispositionVerifications)
        .set({ launchAttemptCount: launchCount, updatedAt: this.now() })
        .where(
          and(
            eq(findingDispositionVerifications.id, verification.id),
            eq(findingDispositionVerifications.status, 'launching'),
            eq(findingDispositionVerifications.leaseOwner, this.workerId),
          ),
        );
    }

    let linkedRunId: string | null = existingRun?.id ?? null;
    try {
      const subscription = this.deps.accessControl
        ? await this.deps.accessControl.resolveOrganizationSubscription({
            organizationId: verification.organizationId,
            userId: verification.requestedByUserId,
          })
        : null;
      if (subscription && parseExperienceProfile(subscription.plan.experienceProfile) !== 'workbench') {
        await this.markTerminal(
          verification,
          'failed',
          'product_experience_denied',
          'Finding verification runs require the Platform workbench experience',
        );
        return 'failed';
      }
      const result = await this.deps.startRunService.startFindingDispositionVerificationRun({
        orgId: verification.organizationId,
        userId: verification.requestedByUserId,
        scopeId: verification.scopeId,
        verificationId: verification.id,
        findingId: verification.findingId,
        requestedState: verification.requestedState,
        snapshot: verification.snapshot,
        launchKey: verification.launchKey,
        reason: verification.reason,
        maxConcurrentRuns: subscription?.plan.limits?.maxConcurrentRuns ?? undefined,
        schedulingClass: subscription ? schedulingClassForPlan(subscription.plan.slug) : undefined,
        beforeKickoff: async ({ run, sessionId }) => {
          linkedRunId = run.id;
          const now = this.now();
          const [updated] = await this.deps.db
            .update(findingDispositionVerifications)
            .set({
              status: 'running',
              runId: run.id,
              sessionId,
              waitReason: null,
              failureCode: null,
              failureReason: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              startedAt: verification.startedAt ?? now,
              updatedAt: now,
            })
            .where(
              and(
                eq(findingDispositionVerifications.id, verification.id),
                eq(findingDispositionVerifications.status, 'launching'),
                eq(findingDispositionVerifications.leaseOwner, this.workerId),
              ),
            )
            .returning({ id: findingDispositionVerifications.id });
          if (!updated) {
            throw new AppError(
              ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
              'Verification was cancelled or superseded before Run kickoff',
            );
          }
          await this.deps.db.insert(findingEvents).values({
            organizationId: verification.organizationId,
            userId: verification.requestedByUserId,
            findingId: verification.findingId,
            type: 'disposition_verification_started',
            note: `Verification ${verification.id} started in Run ${run.id}`,
            createdAt: now,
          });
        },
      });
      linkedRunId = result.run.id;
      if (!result.sessionId) {
        const now = this.now();
        const linked = await this.deps.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(findingDispositionVerifications)
            .set({
              status: 'running',
              runId: result.run.id,
              sessionId: null,
              waitReason: result.run.capacityWaitReason ?? 'waiting_for_capacity',
              failureCode: null,
              failureReason: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(findingDispositionVerifications.id, verification.id),
                eq(findingDispositionVerifications.status, 'launching'),
                eq(findingDispositionVerifications.leaseOwner, this.workerId),
              ),
            )
            .returning({ id: findingDispositionVerifications.id });
          if (!updated) return false;
          await tx.insert(findingEvents).values({
            organizationId: verification.organizationId,
            userId: verification.requestedByUserId,
            findingId: verification.findingId,
            type: 'disposition_verification_queued',
            note: `Verification ${verification.id} queued in Run ${result.run.id}`,
            createdAt: now,
          });
          return true;
        });
        if (!linked) {
          throw new AppError(
            ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            'Verification was cancelled or superseded before its queued Run was linked',
          );
        }
      }
      logger.info({
        workerId: this.workerId,
        verificationId: verification.id,
        seriesId: verification.seriesId,
        attemptNumber: verification.attemptNumber,
        launchAttemptCount: launchCount,
        organizationId: verification.organizationId,
        findingId: verification.findingId,
        runId: result.run.id,
        repaired: result.idempotentReplay,
        queueToLaunchMs: Math.max(0, this.now().getTime() - verification.createdAt.getTime()),
      }, '[FindingDispositionWorker] Verification Run linked');
      if (!result.sessionId) return 'waiting';
      return result.idempotentReplay ? 'repaired' : 'started';
    } catch (error) {
      if (linkedRunId) {
        const [current] = await this.deps.db
          .select({ status: findingDispositionVerifications.status })
          .from(findingDispositionVerifications)
          .where(eq(findingDispositionVerifications.id, verification.id))
          .limit(1);
        if (current && current.status !== 'running') {
          await this.cancelLinkedRun(verification.organizationId, linkedRunId);
        }
      }
      return this.handleLaunchError(verification, launchCount, error);
    }
  }

  private async handleLaunchError(
    verification: FindingDispositionVerificationRow,
    launchCount: number,
    error: unknown,
  ): Promise<ProcessOutcome> {
    const err = toAppError(error);
    const reason = errorContextReason(err);
    if (err.code === ERROR_CODES.RESOURCE_LIMIT_REACHED) {
      await this.markWaiting(verification, 'scope_or_org_capacity', err.message, 30_000, true);
      return 'waiting';
    }
    if (err.code === ERROR_CODES.RESOURCE_CREDITS_EXHAUSTED) {
      await this.markWaiting(verification, 'credits_exhausted', err.message, 15 * 60_000, true);
      return 'waiting';
    }
    if (reason === 'RUNNER_OFFLINE' || reason === 'RUNNER_NOT_ASSIGNED' || reason === 'RUNNER_INCOMPATIBLE') {
      await this.markWaiting(verification, reason.toLowerCase(), err.message, 60_000, true);
      return 'waiting';
    }
    if (
      err.code === ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED
      && !reason
    ) {
      await this.markWaiting(verification, 'replay_prerequisite_unavailable', err.message, 5 * 60_000, true);
      return 'waiting';
    }
    if (launchCount < verification.maxLaunchAttempts) {
      const baseDelayMs = Math.min(
        5 * 60_000,
        15_000 * (2 ** Math.max(0, launchCount - 1)),
      );
      // A narrow jitter window keeps recovery deterministic enough to reason
      // about while preventing a provider outage from waking every row at once.
      const jitterMultiplier = 0.8 + (Math.min(1, Math.max(0, this.random())) * 0.4);
      const delayMs = Math.round(baseDelayMs * jitterMultiplier);
      await this.markWaiting(verification, 'launch_infrastructure', err.message, delayMs, false);
      return 'waiting';
    }
    await this.markTerminal(verification, 'failed', 'launch_attempts_exhausted', err.message);
    return 'failed';
  }

  private async markWaiting(
    verification: FindingDispositionVerificationRow,
    waitReason: string,
    failureReason: string,
    delayMs: number,
    refundLaunchAttempt: boolean,
  ): Promise<void> {
    const now = this.now();
    const transitioned = await this.deps.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(findingDispositionVerifications)
        .set({
          status: 'waiting',
          waitReason,
          failureCode: null,
          failureReason: failureReason.slice(0, 4_000),
          nextAttemptAt: retryAt(now, delayMs),
          leaseOwner: null,
          leaseExpiresAt: null,
          ...(refundLaunchAttempt
            ? { launchAttemptCount: Math.max(0, verification.launchAttemptCount) }
            : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(findingDispositionVerifications.id, verification.id),
            eq(findingDispositionVerifications.status, 'launching'),
          ),
        )
        .returning({ id: findingDispositionVerifications.id });
      if (!updated) return false;
      await tx.insert(findingEvents).values({
        organizationId: verification.organizationId,
        userId: verification.requestedByUserId,
        findingId: verification.findingId,
        type: 'disposition_verification_waiting',
        note: `${waitReason}: ${failureReason}`.slice(0, 4_000),
        createdAt: now,
      });
      return true;
    });
    if (transitioned) {
      logger.info({
        workerId: this.workerId,
        verificationId: verification.id,
        seriesId: verification.seriesId,
        attemptNumber: verification.attemptNumber,
        organizationId: verification.organizationId,
        findingId: verification.findingId,
        waitReason,
        nextAttemptAt: retryAt(now, delayMs).toISOString(),
        launchAttemptRefunded: refundLaunchAttempt,
      }, '[FindingDispositionWorker] Verification waiting');
    }
  }

  private async markTerminal(
    verification: FindingDispositionVerificationRow,
    status: 'failed' | 'cancelled' | 'superseded',
    failureCode: string,
    failureReason: string,
  ): Promise<void> {
    const now = this.now();
    const transitioned = await this.deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`finding-disposition:${verification.findingId}`}, 0))`,
      );
      const [updated] = await tx
        .update(findingDispositionVerifications)
        .set({
          status,
          failureCode,
          failureReason: failureReason.slice(0, 4_000),
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          ...(status === 'cancelled' ? { cancelledAt: now } : {}),
          ...(status === 'superseded' ? { supersededAt: now } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(findingDispositionVerifications.id, verification.id),
            inArray(findingDispositionVerifications.status, [...ACTIVE_VERIFICATION_STATUSES]),
          ),
        )
        .returning({ id: findingDispositionVerifications.id });
      if (!updated) return false;
      await tx.insert(findingEvents).values({
        organizationId: verification.organizationId,
        userId: verification.requestedByUserId,
        findingId: verification.findingId,
        type: `disposition_verification_${status}`,
        note: `${failureCode}: ${failureReason}`.slice(0, 4_000),
        createdAt: now,
      });
      return true;
    });
    if (transitioned) {
      const level = status === 'failed' ? 'warn' : 'info';
      logger[level]({
        workerId: this.workerId,
        verificationId: verification.id,
        seriesId: verification.seriesId,
        attemptNumber: verification.attemptNumber,
        organizationId: verification.organizationId,
        findingId: verification.findingId,
        runId: verification.runId,
        status,
        failureCode,
        durationMs: Math.max(0, now.getTime() - verification.createdAt.getTime()),
      }, '[FindingDispositionWorker] Verification terminalized');
    }
  }

  private async reconcile(limit: number): Promise<number> {
    const rows = await this.deps.db
      .select()
      .from(findingDispositionVerifications)
      .where(inArray(findingDispositionVerifications.status, ['launching', 'running']))
      .orderBy(asc(findingDispositionVerifications.updatedAt))
      .limit(limit);
    let reconciled = 0;
    for (const verification of rows) {
      if (verification.status === 'launching') {
        if (verification.leaseExpiresAt && verification.leaseExpiresAt.getTime() <= this.now().getTime()) {
          const run = await this.deps.runService.getByIdempotencyKey(
            verification.organizationId,
            verification.launchKey,
          );
          if (run) {
            await this.deps.db
              .update(findingDispositionVerifications)
              .set({
                status: 'waiting',
                waitReason: 'repair_existing_run',
                runId: run.id,
                sessionId: run.sessionId,
                nextAttemptAt: this.now(),
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: this.now(),
              })
              .where(
                and(
                  eq(findingDispositionVerifications.id, verification.id),
                  eq(findingDispositionVerifications.status, 'launching'),
                ),
              );
            reconciled += 1;
          }
        }
        continue;
      }
      if (!verification.runId) {
        await this.markTerminal(verification, 'failed', 'missing_run_link', 'Running verification has no linked Run');
        reconciled += 1;
        continue;
      }
      const [run] = await this.deps.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, verification.runId))
        .limit(1);
      if (!run) {
        await this.markTerminal(verification, 'failed', 'run_removed', 'Linked Run no longer exists');
        reconciled += 1;
        continue;
      }
      if (RUN_ACTIVE_STATUSES.includes(run.status)) continue;
      if (run.status === 'cancelled') {
        await this.markTerminal(verification, 'cancelled', 'linked_run_cancelled', 'Linked Run was cancelled');
        reconciled += 1;
        continue;
      }
      if (RUN_TERMINAL_STATUSES.has(run.status)) {
        await this.markTerminal(
          verification,
          'failed',
          run.status === 'failed' ? 'agent_or_run_failed' : 'no_outcome',
          run.status === 'failed'
            ? 'Linked Run failed before an accepted disposition outcome'
            : 'Linked Run completed without an accepted disposition outcome',
        );
        reconciled += 1;
      }
    }
    return reconciled;
  }

  private async cancelLinkedRun(organizationId: string, runId: string): Promise<void> {
    try {
      await abortLiveRunSessions({
        runId,
        services: this.deps.agentServices,
        sessionRepository: this.deps.sessionRepository,
        caller: 'findingDispositionVerificationWorker',
      });
    } finally {
      await this.deps.runService.cancel(organizationId, runId, 'finding_disposition_cancelled');
    }
  }
}
