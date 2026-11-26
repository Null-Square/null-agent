import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseClient } from '@/db/client';
import {
  assets,
  findingDispositionVerifications,
  findingEvents,
  findingEvidence,
  findingValidationAudit,
  findings,
  runs,
  scopeTargets,
  type FindingDispositionRequestedState,
  type FindingDispositionSnapshot,
  type FindingDispositionVerificationOutcome,
  type FindingDispositionVerificationRow,
  type RiskState,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { FindingHttpExchange } from './findingContracts';

const ACTIVE_STATUSES = ['queued', 'waiting', 'launching', 'running'] as const;
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'superseded'] as const;
const MAX_REASON_LENGTH = 4_000;

export const FindingDispositionOutcomeSchema = z.object({
  requestId: z.string().uuid(),
  findingId: z.string().uuid(),
  outcome: z.enum(['fixed', 'still_present', 'false_positive', 'validated', 'inconclusive']),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
  blockerCode: z.string().trim().min(1).max(120).optional(),
  evidence: z.array(z.object({
    path: z.string().trim().min(1),
    label: z.string().trim().min(1).max(500).optional(),
  })).default([]),
  proof: z.object({
    claim: z.string().trim().min(1).max(MAX_REASON_LENGTH),
    replayAttempted: z.boolean(),
    replayReproduced: z.boolean().optional(),
    prerequisitesSatisfied: z.boolean(),
    evidenceIds: z.array(z.string().trim().min(1)).default([]),
    controlEvidenceIds: z.array(z.string().trim().min(1)).default([]),
  }),
});

export type FindingDispositionOutcomeInput = z.infer<typeof FindingDispositionOutcomeSchema>;

export type DispositionVerificationProof = {
  claim: string;
  replayAttempted: boolean;
  replayReproduced?: boolean;
  prerequisitesSatisfied: boolean;
  evidenceIds: string[];
  controlEvidenceIds: string[];
};

export type DispositionVerificationEvidence = {
  kind: 'artifact' | 'http_exchange';
  path: string;
  displayPath: string;
  label?: string;
  /** Current-session source references that resolve to this durable row. */
  aliases?: string[];
  excerpt?: string;
  fileMissing?: boolean;
  data?: FindingHttpExchange | null;
};

export type DispositionVerificationProjection = FindingDispositionVerificationRow & {
  runStatus: string | null;
  runDisplayId: number | null;
};

const normalizeText = (value: string | null | undefined, max = MAX_REASON_LENGTH): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, max) : null;
};

const uniqueStrings = (values: readonly string[] | null | undefined): string[] =>
  Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));

const isTerminalStatus = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

export const dispositionEvidenceReferenceResolves = (
  reference: string,
  currentEvidence: ReadonlyArray<{
    id: string;
    path: string;
    displayPath: string | null;
    label: string | null;
  }>,
  currentAliases: ReadonlySet<string>,
): boolean =>
  currentAliases.has(reference)
  || currentEvidence.some((row) =>
    [row.id, row.path, row.displayPath, row.label]
      .filter((value): value is string => Boolean(value))
      .includes(reference),
  );

export const isAllowedFindingDispositionOutcome = (
  requestedState: FindingDispositionRequestedState,
  outcome: FindingDispositionVerificationOutcome,
): boolean =>
  requestedState === 'resolved'
    ? outcome === 'fixed' || outcome === 'still_present' || outcome === 'inconclusive'
    : outcome === 'false_positive' || outcome === 'validated' || outcome === 'inconclusive';

export const assertFindingDispositionProof = (params: {
  outcome: FindingDispositionVerificationOutcome;
  blockerCode?: string | null;
  proof: DispositionVerificationProof;
}): void => {
  const { outcome, proof } = params;
  if (outcome === 'fixed') {
    if (
      !proof.replayAttempted
      || proof.replayReproduced !== false
      || !proof.prerequisitesSatisfied
      || proof.evidenceIds.length === 0
      || proof.controlEvidenceIds.length === 0
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'fixed requires a non-reproducing replay, satisfied prerequisites, replay evidence, and functioning control evidence',
      );
    }
  }
  if (outcome === 'still_present' || outcome === 'validated') {
    if (
      !proof.replayAttempted
      || proof.replayReproduced !== true
      || proof.evidenceIds.length === 0
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        `${outcome} requires a reproducing replay with fresh evidence`,
      );
    }
  }
  if (outcome === 'false_positive') {
    if (
      !proof.replayAttempted
      || proof.replayReproduced !== false
      || !proof.prerequisitesSatisfied
      || proof.evidenceIds.length === 0
      || proof.controlEvidenceIds.length === 0
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
        'false_positive requires disproof evidence and functioning prerequisite/control evidence',
      );
    }
  }
  if (outcome === 'inconclusive' && !normalizeText(params.blockerCode, 120)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_MISSING_REQUIRED,
      'inconclusive requires a blockerCode',
    );
  }
};

const requestConflict = (message: string): AppError =>
  new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, message, { httpStatus: 409 });

export class FindingDispositionVerificationService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async lockFinding(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    findingId: string,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`finding-disposition:${findingId}`}, 0))`,
    );
  }

  private async buildSnapshot(
    tx: Parameters<Parameters<DatabaseClient['transaction']>[0]>[0],
    finding: typeof findings.$inferSelect,
    capturedAt: Date,
  ): Promise<FindingDispositionSnapshot> {
    const [asset, targets] = await Promise.all([
      finding.assetId
        ? tx
            .select({ id: assets.id, kind: assets.kind, value: assets.value })
            .from(assets)
            .where(eq(assets.id, finding.assetId))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      tx
        .select({
          id: scopeTargets.id,
          type: scopeTargets.type,
          value: scopeTargets.value,
          verified: scopeTargets.verified,
        })
        .from(scopeTargets)
        .where(eq(scopeTargets.scopeId, finding.scopeId)),
    ]);

    return {
      schemaVersion: 1,
      finding: {
        id: finding.id,
        title: finding.title,
        summary: finding.summary,
        severity: finding.severity,
        state: finding.state,
        lifecycleVersion: finding.lifecycleVersion,
        assetId: finding.assetId,
        endpointId: finding.endpointId,
        serviceId: finding.serviceId,
        pocDescription: finding.pocDescription,
        assumptions: finding.assumptions,
      },
      asset,
      targets,
      capturedAt: capturedAt.toISOString(),
    };
  }

  private async projectRows(
    organizationId: string,
    findingId: string,
  ): Promise<DispositionVerificationProjection[]> {
    return this.db
      .select({
        id: findingDispositionVerifications.id,
        seriesId: findingDispositionVerifications.seriesId,
        previousVerificationId: findingDispositionVerifications.previousVerificationId,
        attemptNumber: findingDispositionVerifications.attemptNumber,
        organizationId: findingDispositionVerifications.organizationId,
        scopeId: findingDispositionVerifications.scopeId,
        findingId: findingDispositionVerifications.findingId,
        requestedByUserId: findingDispositionVerifications.requestedByUserId,
        cancelledByUserId: findingDispositionVerifications.cancelledByUserId,
        requestKey: findingDispositionVerifications.requestKey,
        requestedState: findingDispositionVerifications.requestedState,
        reason: findingDispositionVerifications.reason,
        snapshot: findingDispositionVerifications.snapshot,
        priorState: findingDispositionVerifications.priorState,
        findingLifecycleVersion: findingDispositionVerifications.findingLifecycleVersion,
        status: findingDispositionVerifications.status,
        waitReason: findingDispositionVerifications.waitReason,
        failureCode: findingDispositionVerifications.failureCode,
        failureReason: findingDispositionVerifications.failureReason,
        nextAttemptAt: findingDispositionVerifications.nextAttemptAt,
        leaseOwner: findingDispositionVerifications.leaseOwner,
        leaseExpiresAt: findingDispositionVerifications.leaseExpiresAt,
        launchAttemptCount: findingDispositionVerifications.launchAttemptCount,
        maxLaunchAttempts: findingDispositionVerifications.maxLaunchAttempts,
        automaticAttempt: findingDispositionVerifications.automaticAttempt,
        launchKey: findingDispositionVerifications.launchKey,
        runId: findingDispositionVerifications.runId,
        sessionId: findingDispositionVerifications.sessionId,
        outcome: findingDispositionVerifications.outcome,
        outcomeReason: findingDispositionVerifications.outcomeReason,
        blockerCode: findingDispositionVerifications.blockerCode,
        proof: findingDispositionVerifications.proof,
        startedAt: findingDispositionVerifications.startedAt,
        completedAt: findingDispositionVerifications.completedAt,
        cancelledAt: findingDispositionVerifications.cancelledAt,
        supersededAt: findingDispositionVerifications.supersededAt,
        createdAt: findingDispositionVerifications.createdAt,
        updatedAt: findingDispositionVerifications.updatedAt,
        runStatus: runs.status,
        runDisplayId: runs.displayId,
      })
      .from(findingDispositionVerifications)
      .leftJoin(runs, eq(runs.id, findingDispositionVerifications.runId))
      .where(
        and(
          eq(findingDispositionVerifications.organizationId, organizationId),
          eq(findingDispositionVerifications.findingId, findingId),
        ),
      )
      .orderBy(desc(findingDispositionVerifications.createdAt));
  }

  async getHistory(params: {
    organizationId: string;
    findingId: string;
  }): Promise<{
    active: DispositionVerificationProjection | null;
    latest: DispositionVerificationProjection | null;
    attempts: DispositionVerificationProjection[];
  }> {
    const attempts = await this.projectRows(params.organizationId, params.findingId);
    return {
      active: attempts.find((row) => (ACTIVE_STATUSES as readonly string[]).includes(row.status)) ?? null,
      latest: attempts[0] ?? null,
      attempts,
    };
  }

  async getCompactProjections(params: {
    organizationId: string;
    findingIds: string[];
  }): Promise<Map<string, DispositionVerificationProjection>> {
    const findingIds = uniqueStrings(params.findingIds);
    if (findingIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        verification: findingDispositionVerifications,
        runStatus: runs.status,
        runDisplayId: runs.displayId,
      })
      .from(findingDispositionVerifications)
      .leftJoin(runs, eq(runs.id, findingDispositionVerifications.runId))
      .where(
        and(
          eq(findingDispositionVerifications.organizationId, params.organizationId),
          inArray(findingDispositionVerifications.findingId, findingIds),
        ),
      )
      .orderBy(desc(findingDispositionVerifications.createdAt));

    const result = new Map<string, DispositionVerificationProjection>();
    for (const row of rows) {
      if (result.has(row.verification.findingId)) continue;
      result.set(row.verification.findingId, {
        ...row.verification,
        runStatus: row.runStatus,
        runDisplayId: row.runDisplayId,
      });
    }
    return result;
  }

  async request(params: {
    organizationId: string;
    findingId: string;
    requestedByUserId: string;
    requestedState: FindingDispositionRequestedState;
    requestKey: string;
    reason?: string | null;
  }): Promise<{
    verification: FindingDispositionVerificationRow;
    idempotentReplay: boolean;
    supersededRunIds: string[];
  }> {
    const requestKey = params.requestKey.trim();
    if (!requestKey || requestKey.length > 200) {
      throw new AppError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'requestKey is required and must be at most 200 characters',
      );
    }
    const now = this.now();

    return this.db.transaction(async (tx) => {
      await this.lockFinding(tx, params.findingId);

      const [existingRequest] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.organizationId, params.organizationId),
            eq(findingDispositionVerifications.requestKey, requestKey),
          ),
        )
        .limit(1);
      if (existingRequest) {
        if (
          existingRequest.findingId !== params.findingId
          || existingRequest.requestedState !== params.requestedState
          || existingRequest.reason !== normalizeText(params.reason)
        ) {
          throw requestConflict('requestKey was already used for a different finding disposition');
        }
        return {
          verification: existingRequest,
          idempotentReplay: true,
          supersededRunIds: [],
        };
      }

      const [finding] = await tx
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.id, params.findingId),
            eq(findings.organizationId, params.organizationId),
            eq(findings.sourceKind, 'assessment'),
          ),
        )
        .limit(1);
      if (!finding) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Finding not found');
      }

      const [active] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.findingId, params.findingId),
            inArray(findingDispositionVerifications.status, [...ACTIVE_STATUSES]),
          ),
        )
        .limit(1);

      if (active?.requestedState === params.requestedState) {
        return {
          verification: active,
          idempotentReplay: true,
          supersededRunIds: [],
        };
      }

      const supersededRunIds: string[] = [];
      if (active) {
        if (active.runId) supersededRunIds.push(active.runId);
        await tx
          .update(findingDispositionVerifications)
          .set({
            status: 'superseded',
            failureCode: 'conflicting_operator_disposition',
            failureReason: `Superseded by a ${params.requestedState} request`,
            leaseOwner: null,
            leaseExpiresAt: null,
            supersededAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(findingDispositionVerifications.id, active.id));
        await tx.insert(findingEvents).values({
          organizationId: params.organizationId,
          userId: params.requestedByUserId,
          findingId: params.findingId,
          type: 'disposition_verification_superseded',
          note: `Superseded ${active.requestedState} verification ${active.id}`,
          createdAt: now,
        });
      }

      const id = randomUUID();
      const seriesId = randomUUID();
      const snapshot = await this.buildSnapshot(tx, finding, now);
      const [created] = await tx
        .insert(findingDispositionVerifications)
        .values({
          id,
          seriesId,
          organizationId: params.organizationId,
          scopeId: finding.scopeId,
          findingId: finding.id,
          requestedByUserId: params.requestedByUserId,
          requestKey,
          requestedState: params.requestedState,
          reason: normalizeText(params.reason),
          snapshot,
          priorState: finding.state,
          findingLifecycleVersion: finding.lifecycleVersion,
          status: 'queued',
          launchKey: `finding-disposition:${id}`,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) {
        throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to create finding verification');
      }

      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.requestedByUserId,
        findingId: params.findingId,
        type: 'disposition_verification_requested',
        note: `${params.requestedState} verification ${created.id} queued`,
        createdAt: now,
      });

      return { verification: created, idempotentReplay: false, supersededRunIds };
    });
  }

  async retry(params: {
    organizationId: string;
    findingId: string;
    verificationId: string;
    requestedByUserId: string;
    requestKey: string;
  }): Promise<FindingDispositionVerificationRow> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await this.lockFinding(tx, params.findingId);
      const [previous] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.id, params.verificationId),
            eq(findingDispositionVerifications.findingId, params.findingId),
            eq(findingDispositionVerifications.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!previous) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Verification attempt not found');
      if (!isTerminalStatus(previous.status)) {
        throw requestConflict('Only a terminal verification attempt can be retried');
      }

      const [active] = await tx
        .select({ id: findingDispositionVerifications.id })
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.findingId, params.findingId),
            inArray(findingDispositionVerifications.status, [...ACTIVE_STATUSES]),
          ),
        )
        .limit(1);
      if (active) throw requestConflict('A newer verification attempt is already active');

      const [finding] = await tx
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.id, params.findingId),
            eq(findings.organizationId, params.organizationId),
            eq(findings.sourceKind, 'assessment'),
          ),
        )
        .limit(1);
      if (!finding) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Finding not found');

      const requestKey = params.requestKey.trim();
      if (!requestKey || requestKey.length > 200) {
        throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'requestKey is required');
      }
      const [existingRequest] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.organizationId, params.organizationId),
            eq(findingDispositionVerifications.requestKey, requestKey),
          ),
        )
        .limit(1);
      if (existingRequest) {
        if (
          existingRequest.findingId !== params.findingId
          || existingRequest.previousVerificationId !== previous.id
          || existingRequest.requestedState !== previous.requestedState
        ) {
          throw requestConflict('requestKey was already used for a different verification retry');
        }
        return existingRequest;
      }

      const id = randomUUID();
      const snapshot = await this.buildSnapshot(tx, finding, now);
      const [created] = await tx
        .insert(findingDispositionVerifications)
        .values({
          id,
          seriesId: previous.seriesId,
          previousVerificationId: previous.id,
          attemptNumber: previous.attemptNumber + 1,
          organizationId: params.organizationId,
          scopeId: finding.scopeId,
          findingId: finding.id,
          requestedByUserId: params.requestedByUserId,
          requestKey,
          requestedState: previous.requestedState,
          reason: previous.reason,
          snapshot,
          priorState: finding.state,
          findingLifecycleVersion: finding.lifecycleVersion,
          status: 'queued',
          launchKey: `finding-disposition:${id}`,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to retry verification');

      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.requestedByUserId,
        findingId: params.findingId,
        type: 'disposition_verification_requested',
        note: `Retry attempt ${created.attemptNumber} queued from ${previous.id}`,
        createdAt: now,
      });
      return created;
    });
  }

  async cancel(params: {
    organizationId: string;
    findingId: string;
    verificationId: string;
    cancelledByUserId: string;
  }): Promise<{ verification: FindingDispositionVerificationRow; runId: string | null }> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await this.lockFinding(tx, params.findingId);
      const [row] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.id, params.verificationId),
            eq(findingDispositionVerifications.findingId, params.findingId),
            eq(findingDispositionVerifications.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!row) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Verification attempt not found');
      if (isTerminalStatus(row.status)) return { verification: row, runId: null };

      const [updated] = await tx
        .update(findingDispositionVerifications)
        .set({
          status: 'cancelled',
          cancelledByUserId: params.cancelledByUserId,
          failureCode: 'cancelled_by_operator',
          failureReason: 'Cancelled by operator',
          leaseOwner: null,
          leaseExpiresAt: null,
          cancelledAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(findingDispositionVerifications.id, row.id))
        .returning();

      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.cancelledByUserId,
        findingId: params.findingId,
        type: 'disposition_verification_cancelled',
        note: `Verification ${row.id} cancelled`,
        createdAt: now,
      });
      return { verification: updated ?? row, runId: row.runId };
    });
  }

  async supersedeActive(params: {
    organizationId: string;
    findingId: string;
    userId: string;
    reason: string;
  }): Promise<string[]> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await this.lockFinding(tx, params.findingId);
      const rows = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.organizationId, params.organizationId),
            eq(findingDispositionVerifications.findingId, params.findingId),
            inArray(findingDispositionVerifications.status, [...ACTIVE_STATUSES]),
          ),
        );
      if (rows.length === 0) return [];
      await tx
        .update(findingDispositionVerifications)
        .set({
          status: 'superseded',
          failureCode: 'operator_state_changed',
          failureReason: normalizeText(params.reason),
          leaseOwner: null,
          leaseExpiresAt: null,
          supersededAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(inArray(findingDispositionVerifications.id, rows.map((row) => row.id)));
      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.userId,
        findingId: params.findingId,
        type: 'disposition_verification_superseded',
        note: normalizeText(params.reason),
        createdAt: now,
      });
      return rows.map((row) => row.runId).filter((runId): runId is string => Boolean(runId));
    });
  }

  async submitOutcome(params: {
    organizationId: string;
    userId: string;
    runId: string;
    sessionId: string;
    workspaceEvidence: DispositionVerificationEvidence[];
    input: FindingDispositionOutcomeInput;
  }): Promise<{
    verificationId: string;
    findingId: string;
    outcome: FindingDispositionVerificationOutcome;
    status: 'completed';
    canonicalState: RiskState;
    alreadySubmitted: boolean;
  }> {
    const reason = normalizeText(params.input.reason);
    if (!reason) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'Outcome reason is required');
    }
    const proof: DispositionVerificationProof = {
      claim: normalizeText(params.input.proof.claim) ?? '',
      replayAttempted: params.input.proof.replayAttempted === true,
      ...(typeof params.input.proof.replayReproduced === 'boolean'
        ? { replayReproduced: params.input.proof.replayReproduced }
        : {}),
      prerequisitesSatisfied: params.input.proof.prerequisitesSatisfied === true,
      evidenceIds: uniqueStrings(params.input.proof.evidenceIds),
      controlEvidenceIds: uniqueStrings(params.input.proof.controlEvidenceIds),
    };
    if (!proof.claim) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'proof.claim is required');
    }

    const now = this.now();
    return this.db.transaction(async (tx) => {
      await this.lockFinding(tx, params.input.findingId);
      const [verification] = await tx
        .select()
        .from(findingDispositionVerifications)
        .where(
          and(
            eq(findingDispositionVerifications.id, params.input.requestId),
            eq(findingDispositionVerifications.findingId, params.input.findingId),
            eq(findingDispositionVerifications.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!verification) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Disposition verification was not found');
      }
      if (verification.runId !== params.runId || verification.sessionId !== params.sessionId) {
        throw requestConflict('Outcome run/session identity does not match the verification attempt');
      }
      if (verification.status === 'completed' && verification.outcome) {
        if (verification.outcome !== params.input.outcome) {
          throw requestConflict('A different terminal outcome was already accepted');
        }
        const [finding] = await tx
          .select({ state: findings.state })
          .from(findings)
          .where(eq(findings.id, verification.findingId))
          .limit(1);
        return {
          verificationId: verification.id,
          findingId: verification.findingId,
          outcome: verification.outcome,
          status: 'completed',
          canonicalState: finding?.state ?? verification.priorState,
          alreadySubmitted: true,
        };
      }
      if (verification.status !== 'running') {
        throw requestConflict(`Verification is ${verification.status} and cannot accept an outcome`);
      }
      if (!isAllowedFindingDispositionOutcome(verification.requestedState, params.input.outcome)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          `${params.input.outcome} is not allowed for ${verification.requestedState} verification`,
        );
      }

      const [finding] = await tx
        .select()
        .from(findings)
        .where(
          and(
            eq(findings.id, verification.findingId),
            eq(findings.organizationId, params.organizationId),
          ),
        )
        .limit(1);
      if (!finding) throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Finding not found');
      const stale = finding.lifecycleVersion !== verification.findingLifecycleVersion;

      for (const evidence of params.workspaceEvidence) {
        await tx
          .insert(findingEvidence)
          .values({
            organizationId: params.organizationId,
            userId: params.userId,
            findingId: finding.id,
            sessionId: params.sessionId,
            kind: evidence.kind,
            path: evidence.path,
            displayPath: evidence.displayPath,
            label: evidence.label,
            excerpt: evidence.kind === 'artifact' ? evidence.excerpt : undefined,
            fileMissing: evidence.kind === 'artifact' ? evidence.fileMissing ?? false : false,
            data: evidence.kind === 'http_exchange' ? evidence.data ?? null : null,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [findingEvidence.findingId, findingEvidence.path],
            set: {
              sessionId: params.sessionId,
              kind: evidence.kind,
              displayPath: evidence.displayPath,
              label: evidence.label,
              excerpt: evidence.kind === 'artifact' ? evidence.excerpt : undefined,
              fileMissing: evidence.kind === 'artifact' ? evidence.fileMissing ?? false : false,
              data: evidence.kind === 'http_exchange' ? evidence.data ?? null : null,
            },
          });
      }

      if (!stale) {
        const evidenceRows = await tx
          .select({
            id: findingEvidence.id,
            path: findingEvidence.path,
            displayPath: findingEvidence.displayPath,
            label: findingEvidence.label,
            sessionId: findingEvidence.sessionId,
            fileMissing: findingEvidence.fileMissing,
            kind: findingEvidence.kind,
          })
          .from(findingEvidence)
          .where(eq(findingEvidence.findingId, finding.id));
        const currentEvidence = evidenceRows.filter(
          (row) =>
            row.sessionId === params.sessionId
            && (row.kind === 'http_exchange' || row.fileMissing !== true),
        );
        const currentAliases = new Set(
          params.workspaceEvidence.flatMap((evidence) => evidence.aliases ?? []),
        );
        const unresolved = [...proof.evidenceIds, ...proof.controlEvidenceIds].filter(
          (reference) =>
            !dispositionEvidenceReferenceResolves(reference, currentEvidence, currentAliases),
        );
        if (unresolved.length > 0) {
          throw new AppError(
            ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            `Proof references must resolve to durable evidence from this verification session: ${unresolved.join(', ')}`,
          );
        }

        assertFindingDispositionProof({
          outcome: params.input.outcome,
          blockerCode: params.input.blockerCode,
          proof,
        });
      }

      const acceptedOutcome: FindingDispositionVerificationOutcome =
        stale ? 'inconclusive' : params.input.outcome;
      const blockerCode = stale
        ? 'stale_finding_lifecycle'
        : normalizeText(params.input.blockerCode, 120);
      const acceptedReason = stale
        ? 'Risk state changed after this verification was requested; the result was retained as stale evidence only.'
        : reason;

      const priorState = finding.state;
      let canonicalState = finding.state;
      if (!stale) {
        if (acceptedOutcome === 'fixed') canonicalState = 'resolved';
        if (acceptedOutcome === 'still_present') canonicalState = 'confirmed';
        if (acceptedOutcome === 'false_positive') canonicalState = 'dismissed';
        if (acceptedOutcome === 'validated') canonicalState = 'confirmed';
      }

      if (canonicalState !== finding.state) {
        await tx
          .update(findings)
          .set({
            state: canonicalState,
            lifecycleVersion: finding.lifecycleVersion + 1,
            updatedAt: now,
          })
          .where(eq(findings.id, finding.id));
      }

      const proofPayload = {
        schemaVersion: 1,
        ...proof,
        evidenceIds: proof.evidenceIds,
        controlEvidenceIds: proof.controlEvidenceIds,
        stale,
      };
      await tx.insert(findingValidationAudit).values({
        organizationId: params.organizationId,
        userId: params.userId,
        findingId: finding.id,
        workerSessionId: params.sessionId,
        runId: params.runId,
        dispositionVerificationId: verification.id,
        outcome: acceptedOutcome,
        reason: acceptedReason,
        evidenceRefs: [{
          kind: 'validation_proof',
          path: `disposition-verification:${verification.id}`,
          label: 'Finding disposition verification proof',
          schemaVersion: 1,
          proof: proofPayload,
        }],
        completedAt: now,
        createdAt: now,
      });

      const [completed] = await tx
        .update(findingDispositionVerifications)
        .set({
          status: 'completed',
          outcome: acceptedOutcome,
          outcomeReason: acceptedReason,
          blockerCode,
          proof: proofPayload,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(findingDispositionVerifications.id, verification.id),
            eq(findingDispositionVerifications.status, 'running'),
          ),
        )
        .returning();
      if (!completed) throw requestConflict('Verification became terminal before outcome commit');

      if (canonicalState !== priorState) {
        await tx.insert(findingEvents).values({
          organizationId: params.organizationId,
          userId: params.userId,
          findingId: finding.id,
          type: 'state_changed',
          fromState: priorState,
          toState: canonicalState,
          note: `Disposition verification ${verification.id}: ${acceptedOutcome}`,
          createdAt: now,
        });
      }
      await tx.insert(findingEvents).values({
        organizationId: params.organizationId,
        userId: params.userId,
        findingId: finding.id,
        type: acceptedOutcome === 'inconclusive'
          ? 'disposition_verification_inconclusive'
          : 'disposition_verification_completed',
        note: `${acceptedOutcome}: ${acceptedReason}`,
        createdAt: now,
      });

      return {
        verificationId: verification.id,
        findingId: finding.id,
        outcome: acceptedOutcome,
        status: 'completed',
        canonicalState,
        alreadySubmitted: false,
      };
    });
  }
}
