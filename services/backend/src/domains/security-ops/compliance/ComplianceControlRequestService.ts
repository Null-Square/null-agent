import { createHash } from 'crypto';

import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { DatabaseClient } from '@/db/client';
import {
  agentSessions,
  auditLogs,
  complianceControlChecks,
  complianceControlRequests,
  complianceEvidenceItems,
  complianceEvidenceMappings,
  type ComplianceControlRequestStatus,
  runs,
  runPhases,
  scopes,
} from '@/db/schema';
import {
  COMPLIANCE_FRAMEWORK_KEYS,
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';

import { ComplianceReadinessService } from './ComplianceReadinessService';

const RequestTypeSchema = z.enum(['evidence', 'access', 'context', 'remediation']);
const PrioritySchema = z.enum(['low', 'medium', 'high']);
const ReviewOutcomeSchema = z.enum(['reviewed', 'insufficient', 'contradicted']);

export const RecordControlRequestSchema = z.object({
  frameworkKey: z.enum([...COMPLIANCE_FRAMEWORK_KEYS] as [ComplianceFrameworkKey, ...ComplianceFrameworkKey[]]),
  controlId: z.string().trim().min(1).max(128),
  requestType: RequestTypeSchema,
  priority: PrioritySchema.optional().default('medium'),
  title: z.string().trim().min(6).max(180),
  reason: z.string().trim().min(10).max(2_000),
  requestedEvidence: z.array(z.string().trim().min(2).max(300)).max(20).optional().default([]),
  remediationHint: z.string().trim().min(10).max(2_000).optional(),
  assignedToUserId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
}).superRefine((value, ctx) => {
  if (value.requestType === 'evidence' && value.requestedEvidence.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestedEvidence'],
      message: 'evidence requests must name the evidence needed',
    });
  }
  if (value.requestType === 'remediation' && !value.remediationHint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remediationHint'],
      message: 'remediation requests must include a concrete remediation hint',
    });
  }
});

export type RecordControlRequestInput = z.infer<typeof RecordControlRequestSchema>;

export const FulfillControlRequestSchema = z.object({
  evidenceItemId: z.string().uuid(),
  note: z.string().trim().max(2_000).nullable().optional(),
});

export type FulfillControlRequestInput = z.infer<typeof FulfillControlRequestSchema>;

export const ReviewControlRequestSchema = z.object({
  outcome: ReviewOutcomeSchema,
  controlCheckId: z.string().uuid(),
  note: z.string().trim().min(10).max(2_000),
  nextReverificationAt: z.coerce.date().optional(),
});

export type ReviewControlRequestInput = z.infer<typeof ReviewControlRequestSchema>;

const uniqueStrings = (values: string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();

const canonicalControlIdForFramework = (
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): string => {
  const trimmed = controlId.trim();
  const framework = FRAMEWORK_REGISTRY[frameworkKey];
  return framework.controls.find((candidate) => candidate.id.toLowerCase() === trimmed.toLowerCase())?.id ?? trimmed;
};

const pgCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; cause?: unknown };
  return typeof record.code === 'string' ? record.code : pgCode(record.cause);
};

export class ComplianceControlRequestService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(params: {
    userId: string;
    organizationId: string;
    scopeId: string;
    runId: string;
    sessionId: string;
    input: unknown;
  }): Promise<{ requestId: string; created: boolean; status: ComplianceControlRequestStatus }> {
    const parsedInput = RecordControlRequestSchema.parse(params.input);
    const input: RecordControlRequestInput = {
      ...parsedInput,
      controlId: canonicalControlIdForFramework(parsedInput.frameworkKey, parsedInput.controlId),
    };
    const framework = FRAMEWORK_REGISTRY[input.frameworkKey];
    const control = framework.controls.find((candidate) => candidate.id === input.controlId);
    if (!control) {
      throw new Error(`Unknown compliance control ${input.frameworkKey}/${input.controlId}`);
    }

    const [scope, run, session, phaseSessions] = await Promise.all([
      this.db.select({ id: scopes.id }).from(scopes).where(and(eq(scopes.id, params.scopeId), eq(scopes.organizationId, params.organizationId))).limit(1),
      this.db.select({
        id: runs.id,
        complianceFrameworkKey: runs.complianceFrameworkKey,
        sessionId: runs.sessionId,
        plannerSessionId: runs.plannerSessionId,
        executorSessionId: runs.executorSessionId,
      }).from(runs).where(and(eq(runs.id, params.runId), eq(runs.organizationId, params.organizationId), eq(runs.scopeId, params.scopeId))).limit(1),
      this.db.select({ id: agentSessions.id, scopeId: agentSessions.scopeId, userId: agentSessions.userId }).from(agentSessions).where(eq(agentSessions.id, params.sessionId)).limit(1),
      this.db.select({ sessionId: runPhases.sessionId }).from(runPhases).where(eq(runPhases.runId, params.runId)),
    ]);
    if (!scope[0]) throw new Error('Scope not found for organization');
    if (!run[0]) throw new Error('Run not found for organization and scope');
    if (!session[0] || session[0].scopeId !== params.scopeId || (session[0].userId && session[0].userId !== params.userId)) {
      throw new Error('Session is not bound to the current user and scope');
    }
    const runSessionIds = new Set([
      run[0].sessionId,
      run[0].plannerSessionId,
      run[0].executorSessionId,
      ...phaseSessions.map((phase) => phase.sessionId),
    ].filter((value): value is string => Boolean(value)));
    if (!runSessionIds.has(params.sessionId)) {
      throw new Error('Session is not bound to the current run');
    }
    if (run[0].complianceFrameworkKey && run[0].complianceFrameworkKey !== input.frameworkKey) {
      throw new Error(
        `record_control_request is scoped to ${run[0].complianceFrameworkKey} for this run; ` +
          `received ${input.frameworkKey}/${input.controlId}`,
      );
    }

    const selectedFrameworks = await new ComplianceReadinessService(this.db).getScopeReadiness({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
    });
    if (!selectedFrameworks.selectedFrameworks.some((selected) => selected.key === input.frameworkKey)) {
      throw new Error(`Framework ${input.frameworkKey} is not selected for this scope`);
    }

    const dueAt = input.dueAt ?? null;
    if (dueAt && dueAt <= this.now()) {
      throw new Error('dueAt must be in the future');
    }
    const requestedEvidence = uniqueStrings(input.requestedEvidence);
    const idempotencyKey = createHash('sha256').update(JSON.stringify({
      organizationId: params.organizationId,
      scopeId: params.scopeId,
      frameworkKey: input.frameworkKey,
      controlId: input.controlId,
      requestType: input.requestType,
      requestedEvidence,
    })).digest('hex');

    const activeStatuses: ComplianceControlRequestStatus[] = ['open', 'fulfilled', 'insufficient', 'contradicted'];
    const existingByIdempotency = await this.db.select({
      id: complianceControlRequests.id,
      status: complianceControlRequests.status,
      requestedEvidence: complianceControlRequests.requestedEvidence,
      title: complianceControlRequests.title,
      reason: complianceControlRequests.reason,
      remediationHint: complianceControlRequests.remediationHint,
    })
      .from(complianceControlRequests)
      .where(and(
        eq(complianceControlRequests.idempotencyKey, idempotencyKey),
        inArray(complianceControlRequests.status, activeStatuses),
      ))
      .limit(1);
    const existingByControl = existingByIdempotency[0]
      ? []
      : await this.db.select({
        id: complianceControlRequests.id,
        status: complianceControlRequests.status,
        requestedEvidence: complianceControlRequests.requestedEvidence,
        title: complianceControlRequests.title,
        reason: complianceControlRequests.reason,
        remediationHint: complianceControlRequests.remediationHint,
      })
        .from(complianceControlRequests)
        .where(and(
          eq(complianceControlRequests.organizationId, params.organizationId),
          eq(complianceControlRequests.scopeId, params.scopeId),
          eq(complianceControlRequests.frameworkKey, input.frameworkKey),
          eq(complianceControlRequests.controlId, input.controlId),
          eq(complianceControlRequests.requestType, input.requestType),
          inArray(complianceControlRequests.status, activeStatuses),
        ))
        .orderBy(desc(complianceControlRequests.updatedAt))
        .limit(1);
    const existing = existingByIdempotency[0] ?? existingByControl[0];
    if (existing) {
      const now = this.now();
      const existingRequest = existing;
      const preserveFulfilledPayload = existingRequest.status === 'fulfilled';
      const mergedRequestedEvidence = uniqueStrings([
        ...(existingRequest.requestedEvidence ?? []),
        ...requestedEvidence,
      ]);
      await this.db.transaction(async (tx) => {
        await tx
          .update(complianceControlRequests)
          .set({
            runId: params.runId,
            sessionId: params.sessionId,
            priority: input.priority,
            title: preserveFulfilledPayload ? existingRequest.title : input.title,
            reason: preserveFulfilledPayload ? existingRequest.reason : input.reason,
            requestedEvidence: mergedRequestedEvidence,
            remediationHint: preserveFulfilledPayload ? existingRequest.remediationHint : input.remediationHint ?? null,
            assignedToUserId: input.assignedToUserId ?? null,
            dueAt,
            updatedAt: now,
          })
          .where(eq(complianceControlRequests.id, existingRequest.id));
        await tx.insert(auditLogs).values({
          organizationId: params.organizationId,
          actorId: params.sessionId,
          actorType: 'system',
          action: 'compliance.control_request.refreshed',
          resourceType: 'compliance_control_request',
          resourceId: existingRequest.id,
          changes: {
            frameworkKey: input.frameworkKey,
            controlId: input.controlId,
            requestType: input.requestType,
            priority: input.priority,
            status: existingRequest.status,
          },
          metadata: {
            runId: params.runId,
            scopeId: params.scopeId,
            sessionId: params.sessionId,
            dedupeScope: existingByIdempotency[0] ? 'idempotency_key' : 'active_control_request',
          },
        });
      });
      return { requestId: existingRequest.id, created: false, status: existingRequest.status };
    }

    try {
      const row = await this.db.transaction(async (tx) => {
        const [created] = await tx.insert(complianceControlRequests).values({
          organizationId: params.organizationId,
          scopeId: params.scopeId,
          runId: params.runId,
          sessionId: params.sessionId,
          frameworkKey: input.frameworkKey,
          controlId: input.controlId,
          requestType: input.requestType,
          priority: input.priority,
          title: input.title,
          reason: input.reason,
          requestedEvidence,
          remediationHint: input.remediationHint ?? null,
          assignedToUserId: input.assignedToUserId ?? null,
          dueAt,
          createdByActorType: 'agent',
          createdByActorId: params.sessionId,
          idempotencyKey,
        }).returning({ id: complianceControlRequests.id });
        if (!created) throw new Error('Failed to create compliance control request');
        await tx.insert(auditLogs).values({
          organizationId: params.organizationId,
          actorId: params.sessionId,
          actorType: 'system',
          action: 'compliance.control_request.recorded',
          resourceType: 'compliance_control_request',
          resourceId: created.id,
          changes: {
            frameworkKey: input.frameworkKey,
            controlId: input.controlId,
            requestType: input.requestType,
            priority: input.priority,
          },
          metadata: { runId: params.runId, scopeId: params.scopeId, sessionId: params.sessionId },
        });
        return created;
      });
      return { requestId: row.id, created: true, status: 'open' };
    } catch (error) {
      if (pgCode(error) === '23505') {
        const duplicate = await this.db.select({
          id: complianceControlRequests.id,
          status: complianceControlRequests.status,
        })
          .from(complianceControlRequests)
          .where(eq(complianceControlRequests.idempotencyKey, idempotencyKey))
          .limit(1);
        if (duplicate[0]) {
          return { requestId: duplicate[0].id, created: false, status: duplicate[0].status };
        }
      }
      throw error;
    }
  }

  async fulfill(params: {
    userId: string;
    organizationId: string;
    requestId: string;
    input: unknown;
  }): Promise<{ requestId: string; status: 'fulfilled'; evidenceItemId: string }> {
    const input = FulfillControlRequestSchema.parse(params.input);
    const [request] = await this.db
      .select()
      .from(complianceControlRequests)
      .where(and(
        eq(complianceControlRequests.id, params.requestId),
        eq(complianceControlRequests.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!request) {
      throw new Error('Compliance control request not found');
    }
    if (!['open', 'insufficient', 'contradicted'].includes(request.status)) {
      throw new Error(`Compliance control request is already ${request.status}`);
    }

    const [evidence] = await this.db
      .select()
      .from(complianceEvidenceItems)
      .where(and(
        eq(complianceEvidenceItems.id, input.evidenceItemId),
        eq(complianceEvidenceItems.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!evidence) {
      throw new Error('Compliance evidence item not found');
    }
    if (evidence.scopeId && evidence.scopeId !== request.scopeId) {
      throw new Error('Compliance evidence item is outside the request scope');
    }

    const mapping = await this.db
      .select({ id: complianceEvidenceMappings.id })
      .from(complianceEvidenceMappings)
      .where(and(
        eq(complianceEvidenceMappings.evidenceItemId, evidence.id),
        eq(complianceEvidenceMappings.frameworkKey, request.frameworkKey),
        eq(complianceEvidenceMappings.controlId, request.controlId),
      ))
      .limit(1);
    if (!mapping[0]) {
      throw new Error('Compliance evidence item is not mapped to this requested control');
    }

    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(complianceControlRequests)
        .set({
          status: 'fulfilled',
          fulfillmentEvidenceItemId: evidence.id,
          fulfillmentNote: input.note ?? null,
          fulfilledByUserId: params.userId,
          fulfilledAt: now,
          updatedAt: now,
        })
        .where(eq(complianceControlRequests.id, request.id));
      await tx.insert(auditLogs).values({
        organizationId: params.organizationId,
        actorId: params.userId,
        actorType: 'user',
        action: 'compliance.control_request.fulfilled',
        resourceType: 'compliance_control_request',
        resourceId: request.id,
        changes: {
          frameworkKey: request.frameworkKey,
          controlId: request.controlId,
          evidenceItemId: evidence.id,
        },
        metadata: { scopeId: request.scopeId, runId: request.runId },
      });
    });

    return { requestId: request.id, status: 'fulfilled', evidenceItemId: evidence.id };
  }

  async review(params: {
    actorId: string;
    actorType?: 'agent' | 'system' | 'operator';
    organizationId: string;
    runId?: string;
    requestId: string;
    input: unknown;
  }): Promise<{
    requestId: string;
    status: 'reviewed' | 'insufficient' | 'contradicted';
    controlCheckId: string;
    nextReverificationAt: string | null;
  }> {
    const input = ReviewControlRequestSchema.parse(params.input);
    const [request] = await this.db
      .select()
      .from(complianceControlRequests)
      .where(and(
        eq(complianceControlRequests.id, params.requestId),
        eq(complianceControlRequests.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!request) {
      throw new Error('Compliance control request not found');
    }
    if (request.status !== 'fulfilled') {
      if (
        ['reviewed', 'insufficient', 'contradicted'].includes(request.status) &&
        request.reviewControlCheckId === input.controlCheckId &&
        request.status === input.outcome
      ) {
        return {
          requestId: request.id,
          status: request.status as 'reviewed' | 'insufficient' | 'contradicted',
          controlCheckId: input.controlCheckId,
          nextReverificationAt: request.nextReverificationAt?.toISOString() ?? null,
        };
      }
      throw new Error(`Compliance control request is already ${request.status}`);
    }

    const [check] = await this.db
      .select({
        id: complianceControlChecks.id,
        organizationId: complianceControlChecks.organizationId,
        scopeId: complianceControlChecks.scopeId,
        frameworkKey: complianceControlChecks.frameworkKey,
        controlId: complianceControlChecks.controlId,
        basis: complianceControlChecks.basis,
        runId: complianceControlChecks.runId,
        freshUntil: complianceControlChecks.freshUntil,
      })
      .from(complianceControlChecks)
      .where(and(
        eq(complianceControlChecks.id, input.controlCheckId),
        eq(complianceControlChecks.organizationId, params.organizationId),
      ))
      .limit(1);
    if (!check) {
      throw new Error('Compliance control check not found');
    }
    if (params.runId && check.runId !== params.runId) {
      throw new Error('Compliance control check is not from the current review run');
    }
    if (
      check.scopeId !== request.scopeId ||
      check.frameworkKey !== request.frameworkKey ||
      check.controlId.trim().toUpperCase() !== request.controlId.trim().toUpperCase()
    ) {
      throw new Error('Compliance control check does not review this request control');
    }
    if (!['agent_reviewed_user_evidence', 'agent_reviewed_integration'].includes(check.basis)) {
      throw new Error('Compliance request review must be backed by an evidence-review control check');
    }

    const now = this.now();
    const nextReverificationAt = input.nextReverificationAt ?? (input.outcome === 'reviewed' ? check.freshUntil : null);
    if (nextReverificationAt && nextReverificationAt <= now) {
      throw new Error('nextReverificationAt must be in the future');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(complianceControlRequests)
        .set({
          status: input.outcome,
          reviewControlCheckId: check.id,
          reviewNote: input.note,
          reviewedByActorType: params.actorType ?? 'agent',
          reviewedByActorId: params.actorId,
          reviewedAt: now,
          nextReverificationAt,
          updatedAt: now,
        })
        .where(eq(complianceControlRequests.id, request.id));
      await tx.insert(auditLogs).values({
        organizationId: params.organizationId,
        actorId: params.actorId,
        actorType: params.actorType === 'agent' ? 'system' : params.actorType ?? 'system',
        action: 'compliance.control_request.reviewed',
        resourceType: 'compliance_control_request',
        resourceId: request.id,
        changes: {
          frameworkKey: request.frameworkKey,
          controlId: request.controlId,
          outcome: input.outcome,
          controlCheckId: check.id,
          nextReverificationAt: nextReverificationAt?.toISOString() ?? null,
        },
        metadata: { scopeId: request.scopeId, runId: request.runId, reviewedByActorType: params.actorType ?? 'agent' },
      });
    });

    return {
      requestId: request.id,
      status: input.outcome,
      controlCheckId: check.id,
      nextReverificationAt: nextReverificationAt?.toISOString() ?? null,
    };
  }
}
