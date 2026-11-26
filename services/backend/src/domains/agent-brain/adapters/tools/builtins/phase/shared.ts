import { promises as fs } from 'fs';
import path from 'path';
import { z, ZodError } from 'zod';
import { and, count, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { codeReviewFindings, codeReviewReports, runs } from '@/db/schema';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { PlanItem, SessionFlags, StepStatus } from '@/domains/agent-brain/domain/types';
import { normalizeMissionEnvelopeNodes } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import { FRAMEWORK_REGISTRY, type ComplianceFrameworkKey } from '@/domains/security-ops/compliance/frameworks';
import { isComplianceFrameworkKey } from '@/domains/security-ops/compliance/profile';
import { listLiveWorkerTasks } from '@/domains/security-ops/runs/lifecyclePredicates';
import {
  resolvePhaseState,
  type ResolvedPhaseState,
} from '@/domains/security-ops/runs/phaseStateResolver';
import {
  normalizePhaseKey,
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import { SkillLoader, type SkillMetadata } from '@/domains/security-ops/skills/SkillLoader';
import { SecurityOpsToolService } from '@/domains/security-ops/tools/SecurityOpsToolService';
import { LeadPromptRenderer } from '@/domains/security-ops/validation/LeadPromptRenderer';
import { resolveSecurityOpsToolContext } from '../securityopsContext';

export const canonicalWritesSchema = z.object({
  notes: z.array(z.string().min(1)).default([]),
  findings: z.array(z.string().min(1)).default([]),
  assets: z.array(z.string().min(1)).default([]),
  services: z.array(z.string().min(1)).default([]),
});

export const phaseHandoffSchema = z.object({
  phaseId: z.string().uuid().optional(),
  phase: z.string().min(1).optional(),
  status: z.enum(['completed', 'blocked', 'failed']),
  summary: z.string().min(1),
  completedObjectives: z.array(z.string().min(1)).default([]),
  unresolvedQuestions: z.array(z.string().min(1)).default([]),
  artifacts: z.array(z.string().min(1)).default([]),
  canonicalWrites: canonicalWritesSchema.default({
    notes: [],
    findings: [],
    assets: [],
    services: [],
  }),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  validationQueue: z.array(z.string().min(1)).optional(),
  validationTargets: z.array(z.record(z.unknown())).optional(),
  scannerIngestWaivers: z.array(z.object({
    parser: z.string().min(1).optional(),
    artifactPath: z.string().min(1),
    reason: z.string().min(1),
    nextStep: z.string().min(1),
  })).default([]),
  recommendedNextPhase: z.string().min(1).optional(),
  recommendedNextSkills: z.array(z.string().min(1)).optional(),
  closeoutOutcome: z
    .enum(['no_findings_after_coverage', 'interim_blocked', 'needs_operator_input'])
    .optional(),
  replanRequest: z
    .object({
      needed: z.boolean(),
      reason: z.string().min(1).optional(),
    })
    .optional(),
  operatorActionRequired: z
    .object({
      needed: z.boolean(),
      request: z.string().min(1).optional(),
    })
    .optional(),
});

export const phaseCheckpointSchema = z.object({
  phaseId: z.string().uuid().optional(),
  phase: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional(),
  summary: z.string().min(1),
  completedObjectives: z.array(z.string().min(1)).default([]),
  pendingObjectives: z.array(z.string().min(1)).default([]),
  canonicalWrites: canonicalWritesSchema.default({
    notes: [],
    findings: [],
    assets: [],
    services: [],
  }),
  evidenceRefs: z.array(z.string().min(1)).default([]),
  nextSuggestedAction: z.string().min(1).optional(),
});

export const phaseHandoffPreflightSchema = phaseHandoffSchema.partial();

export const phaseRepo = new RunPhaseRepository(db);
export const skillLoader = new SkillLoader();
export const securityOpsService = new SecurityOpsToolService({ db });
export const leadPromptRenderer = new LeadPromptRenderer();
export type PhaseHandoffStatus = 'completed' | 'blocked' | 'failed';

export type ParsedPhaseHandoff = z.infer<typeof phaseHandoffSchema>;
export type ActiveRunPhase = {
  id: string;
  runId: string;
  phaseKey: string;
  handoffSchemaVersion: number;
  stepIds?: unknown;
};

export type PhaseHandoffGateCode =
  | 'active_phase_missing'
  | 'active_phase_id_mismatch'
  | 'active_phase_key_mismatch'
  | 'unknown_recommended_skill'
  | 'noncanonical_recommended_next_phase'
  | 'phase_incompatible_recommended_skill'
  | 'terminal_reporting_next_work'
  | 'zero_finding_reporting_closeout_required'
  | 'live_worker_tasks'
  | 'undispositioned_enumeration_results'
  | 'scanner_ingest_debt'
  | 'open_validation_leads'
  | 'unclosed_validation_findings'
  | 'missing_finding_disposition_outcome'
  | 'missing_control_checks'
  | 'unpublished_code_review_candidates'
  | 'missing_code_review_report';

export type PhaseHandoffGateFailure = {
  code: PhaseHandoffGateCode;
  message: string;
  severity: 'blocking';
  suggestedTool?: string;
  currentState?: Record<string, unknown>;
  expectedShape?: Record<string, unknown>;
  repairExample?: Record<string, unknown>;
};

export type PhaseHandoffGateFailureState = {
  key: string;
  toolName: string;
  code: PhaseHandoffGateCode;
  count: number;
  message: string;
  lastRejectedAt: number;
  lastRejectedPayload: Record<string, unknown>;
  gate: PhaseHandoffGateFailure;
  circuitBreaker: boolean;
};

export const CANONICAL_PHASE_KEYS: readonly RunPhaseKey[] = [
  'planning',
  'recon',
  'enumeration',
  'validation',
  'evidence',
  'control_assessment',
  'reporting',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
];
export const PHASE_HANDOFF_REPAIR_NUDGE_THRESHOLD = 2;
export const PHASE_HANDOFF_CIRCUIT_BREAKER_THRESHOLD = 3;

export const finalStepStatuses: ReadonlySet<StepStatus> = new Set(['completed', 'blocked', 'error']);

export const getPhaseStepIdSet = (value: unknown): Set<string> | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return ids.length > 0 ? new Set(ids) : null;
};

export const handoffStatusToStepStatus = (status: PhaseHandoffStatus): StepStatus => {
  if (status === 'completed') {
    return 'completed';
  }
  return status === 'blocked' ? 'blocked' : 'error';
};

export const compactSummary = (value: string): string =>
  value.length > 512 ? `${value.slice(0, 509)}...` : value;

export const compactJsonPreview = (value: unknown, maxChars = 2000): Record<string, unknown> => {
  try {
    const json = JSON.stringify(value);
    if (!json) {
      return {};
    }
    if (json.length <= maxChars) {
      const parsed = JSON.parse(json) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { value: parsed };
    }
    return {
      truncated: true,
      preview: json.slice(0, maxChars),
      originalLength: json.length,
    };
  } catch {
    return { preview: String(value).slice(0, maxChars) };
  }
};

export const handoffGateFailure = (
  code: PhaseHandoffGateCode,
  message: string,
  details: Omit<PhaseHandoffGateFailure, 'code' | 'message' | 'severity'> = {},
): PhaseHandoffGateFailure => ({
  code,
  message,
  severity: 'blocking',
  ...details,
});

export const evaluateLiveWorkerTaskGate = async (ctx: ToolContext): Promise<PhaseHandoffGateFailure | null> => {
  await ctx.workers?.syncWorkerTasks(ctx.sessionId).catch((error) => {
    ctx.trace?.write(
      ctx.sessionId,
      ctx.turnNumber ?? 0,
      {
        event: 'phase_handoff.worker_sync_failed',
        severity: 'warn',
        note: 'failed to sync worker task state before phase handoff gate',
        payload: { error: error instanceof Error ? error.message : String(error) },
      },
    ).catch(() => undefined);
  });
  const session = ctx.sessionStore.get(ctx.sessionId);
  const liveTasks = listLiveWorkerTasks(session?.workerTasks);
  if (liveTasks.length > 0) {
    return handoffGateFailure(
      'live_worker_tasks',
      `submit_phase_handoff blocked: ${liveTasks.length} delegated worker task(s) are still live. Wait for each worker with wait_for_worker, or stop unneeded workers with stop_worker, before closing the phase.`,
      {
        suggestedTool: 'wait_for_worker',
        currentState: {
          liveWorkerTasks: liveTasks.map((task) => ({
            taskId: task.taskId,
            workerType: task.workerType,
            status: task.status,
            workerSessionId: task.workerSessionId,
            executionMode: task.executionMode,
            dependencyMode: task.dependencyMode ?? 'sidecar',
            expectedArtifactType: task.expectedArtifactType,
          })),
        },
        expectedShape: {
          liveWorkersMustBeSettled: ['completed', 'failed', 'cancelled'],
          allowedActions: ['wait_for_worker', 'stop_worker'],
        },
        repairExample: {
          waitForWorker: { taskId: liveTasks[0]?.taskId },
          stopWorker: { taskId: liveTasks[0]?.taskId, reason: 'phase closeout no longer needs this sidecar result' },
        },
      },
    );
  }

  const undispositionedEnumerationTasks = (session?.workerTasks ?? []).filter(
    (task) => task.workerType === 'enumeration_worker' && !task.enumerationDisposition,
  );
  if (undispositionedEnumerationTasks.length === 0) {
    return null;
  }
  return handoffGateFailure(
    'undispositioned_enumeration_results',
    `submit_phase_handoff blocked: ${undispositionedEnumerationTasks.length} terminal enumeration worker task(s) still require a result disposition or explicit terminal acknowledgement.`,
    {
      suggestedTool: 'submit_enumeration_disposition',
      currentState: {
        tasks: undispositionedEnumerationTasks.map((task) => ({
          taskId: task.taskId,
          status: task.status,
          resultHash: task.artifact?.enumeration?.resultHash,
          hasTypedResult: Boolean(task.artifact?.enumeration),
        })),
      },
      expectedShape: {
        typedResultAction: 'disposition',
        missingResultAction: 'acknowledge_terminal',
        everyLeadDisposedExactlyOnce: true,
      },
      repairExample: {
        action: undispositionedEnumerationTasks[0]?.artifact?.enumeration
          ? 'disposition'
          : 'acknowledge_terminal',
        taskId: undispositionedEnumerationTasks[0]?.taskId,
        resultHash: undispositionedEnumerationTasks[0]?.artifact?.enumeration?.resultHash,
      },
    },
  );
};

export const uniqueLinks = (links: readonly string[]): string[] =>
  Array.from(new Set(links.filter((link) => link.trim().length > 0)));

export const closeSessionPlanForHandoff = async (
  ctx: ToolContext,
  phase: { stepIds?: unknown },
  status: PhaseHandoffStatus,
  summary: string,
  handoffRef: string,
): Promise<void> => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  if (!session || !Array.isArray(session.plan) || session.plan.length === 0) {
    return;
  }

  const phaseStepIds = getPhaseStepIdSet(phase.stepIds);
  const targetSteps = session.plan.filter((step) =>
    !finalStepStatuses.has(step.status) &&
    (phaseStepIds ? phaseStepIds.has(step.id) : true),
  );
  if (targetSteps.length === 0) {
    return;
  }

  const nextStatus = handoffStatusToStepStatus(status);
  const completedAt = Date.now();
  const transition = ctx.planRuntime?.transitionPlanStep?.bind(ctx.planRuntime);

  if (typeof transition === 'function') {
    for (const step of targetSteps) {
      await transition(
        ctx.sessionId,
        step.id,
        nextStatus,
        {
          completedAt,
          outputSnippet: compactSummary(summary),
          artifactLinks: uniqueLinks([...(step.artifactLinks ?? []), handoffRef]),
          ...(nextStatus === 'completed' ? { blockedReason: undefined } : { blockedReason: summary }),
        },
      );
    }
    return;
  }

  const targetIds = new Set(targetSteps.map((step) => step.id));
  const nextPlan: PlanItem[] = session.plan.map((step) => {
    if (!targetIds.has(step.id)) {
      return step;
    }
    return {
      ...step,
      status: nextStatus,
      completedAt,
      outputSnippet: compactSummary(summary),
      artifactLinks: uniqueLinks([...(step.artifactLinks ?? []), handoffRef]),
      ...(nextStatus === 'completed' ? { blockedReason: undefined } : { blockedReason: summary }),
    };
  });
  await ctx.sessionStore.setAsync(
    ctx.sessionId,
    {
      ...session,
      plan: nextPlan,
      currentPlanStepId: targetIds.has(session.currentPlanStepId ?? '') ? undefined : session.currentPlanStepId,
    },
    'securityops.phase_handoff_plan_closed',
  );
  ctx.streamBroker.emit(ctx.sessionId, { type: 'plan_update', data: nextPlan });
};

export const formatToolError = (error: unknown): string => {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

export const uniqueSkillSlugs = (values: readonly string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeSkillSlug(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const closestSkillSlugs = (slug: string, catalog: readonly SkillMetadata[]): string[] => {
  const normalized = normalizeSkillSlug(slug);
  const tokens = normalized.split(/[-_.]+/u).filter(Boolean);
  return catalog
    .map((skill) => {
      const candidate = normalizeSkillSlug(skill.slug);
      const candidateTokens = candidate.split(/[-_.]+/u).filter(Boolean);
      const sharedTokens = tokens.filter((token) => candidateTokens.includes(token)).length;
      const contains = candidate.includes(normalized) || normalized.includes(candidate) ? 2 : 0;
      const prefix = candidate[0] === normalized[0] ? 1 : 0;
      return { slug: skill.slug, score: sharedTokens * 3 + contains + prefix };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
    .slice(0, 3)
    .map((entry) => entry.slug);
};

export const evaluateRecommendedSkillsGate = async (params: {
  recommendedNextSkills?: string[];
  recommendedNextPhase?: string;
  replanRequested: boolean;
}): Promise<PhaseHandoffGateFailure | null> => {
  const targetPhase = normalizePhaseKey(params.recommendedNextPhase);
  if (params.recommendedNextPhase && !targetPhase) {
    return handoffGateFailure(
      'noncanonical_recommended_next_phase',
      `recommendedNextPhase "${params.recommendedNextPhase}" is not a canonical phase. Use an exact Pentest, Compliance, or Code Review phase key.`,
      {
        currentState: { recommendedNextPhase: params.recommendedNextPhase },
        expectedShape: { recommendedNextPhase: CANONICAL_PHASE_KEYS.filter((phase) => phase !== 'planning') },
        repairExample: { recommendedNextPhase: 'validation' },
      },
    );
  }

  const recommended = uniqueSkillSlugs(params.recommendedNextSkills);
  if (recommended.length === 0) {
    return null;
  }

  const catalog = await skillLoader.loadSkillCatalog();
  const catalogBySlug = new Map(catalog.map((skill) => [normalizeSkillSlug(skill.slug), skill]));
  const unknown = recommended.filter((slug) => !catalogBySlug.has(slug));
  if (unknown.length > 0) {
    const suggestionText = unknown
      .map((slug) => {
        const suggestions = closestSkillSlugs(slug, catalog);
        return suggestions.length > 0 ? `${slug} (closest: ${suggestions.join(', ')})` : slug;
      })
      .join('; ');
    return handoffGateFailure(
      'unknown_recommended_skill',
      `Unknown recommendedNextSkills: ${suggestionText}. Use live skill catalog slugs only.`,
      {
        suggestedTool: 'recon_handoff_preflight',
        currentState: { recommendedNextSkills: recommended, unknownRecommendedNextSkills: unknown },
        expectedShape: { recommendedNextSkills: ['live-skill-catalog-slug'] },
        repairExample: {
          recommendedNextSkills: recommended.filter((slug) => catalogBySlug.has(slug)),
          replanRequest: { needed: false },
        },
      },
    );
  }

  if (!targetPhase || params.replanRequested) {
    return null;
  }

  for (const slug of recommended) {
    const skill = catalogBySlug.get(slug);
    if (!skill) {
      continue;
    }
    const compatibilityError = phaseProfileRegistry.validateSkillAssignment(targetPhase, skill);
    if (compatibilityError) {
      return handoffGateFailure(
        'phase_incompatible_recommended_skill',
        `${compatibilityError}. Phase-incompatible recommended skills require replanRequest.needed=true.`,
        {
          currentState: {
            recommendedNextPhase: targetPhase,
            recommendedNextSkills: recommended,
            incompatibleSkill: skill.slug,
          },
          expectedShape: {
            recommendedNextSkills: 'only skills compatible with recommendedNextPhase',
            replanRequest: { needed: true, reason: 'required when intentionally changing the phase plan' },
          },
          repairExample: {
            recommendedNextPhase: targetPhase,
            recommendedNextSkills: recommended.filter((candidate) => candidate !== slug),
          },
        },
      );
    }
  }

  return null;
};

export const readSecurityOpsFlagNumber = (ctx: ToolContext, key: string): number => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  const securityops =
    session?.flags && typeof session.flags.securityops === 'object' && session.flags.securityops !== null
      ? session.flags.securityops as Record<string, unknown>
      : {};
  const value = securityops[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export const readSecurityOpsFlagString = (ctx: ToolContext, key: string): string | undefined => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  const securityops =
    session?.flags && typeof session.flags.securityops === 'object' && session.flags.securityops !== null
      ? session.flags.securityops as Record<string, unknown>
      : {};
  const value = securityops[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

export const hasSecurityOpsFlagObject = (ctx: ToolContext, key: string): boolean => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  const securityops =
    session?.flags && typeof session.flags.securityops === 'object' && session.flags.securityops !== null
      ? session.flags.securityops as Record<string, unknown>
      : {};
  const value = securityops[key];
  return typeof value === 'object' && value !== null;
};

export const evaluateTerminalReportingGate = (params: {
  ctx: ToolContext;
  phaseKey: RunPhaseKey;
  status: PhaseHandoffStatus;
  recommendedNextPhase?: string;
  recommendedNextSkills?: string[];
  closeoutOutcome?: string;
  replanRequested: boolean;
  operatorActionRequired: boolean;
}): PhaseHandoffGateFailure | null => {
  if (params.phaseKey !== 'reporting') {
    return null;
  }

  const hasNextWork =
    typeof params.recommendedNextPhase === 'string' ||
    (Array.isArray(params.recommendedNextSkills) && params.recommendedNextSkills.length > 0);
  if (
    params.status === 'completed' &&
    hasNextWork &&
    !params.replanRequested &&
    !params.operatorActionRequired
  ) {
    return handoffGateFailure(
      'terminal_reporting_next_work',
      'reporting cannot complete with recommendedNextPhase or recommendedNextSkills. Submit blocked/replan/operator action, or omit next-work fields for terminal closeout.',
      {
        suggestedTool: 'reporting_handoff_preflight',
        currentState: {
          status: params.status,
          recommendedNextPhase: params.recommendedNextPhase,
          recommendedNextSkills: params.recommendedNextSkills ?? [],
          replanRequested: params.replanRequested,
          operatorActionRequired: params.operatorActionRequired,
        },
        expectedShape: {
          completed: {
            recommendedNextPhase: undefined,
            recommendedNextSkills: [],
          },
          blockedOrReplan: {
            status: 'blocked',
            replanRequest: { needed: true, reason: 'why another phase is needed' },
          },
        },
        repairExample: {
          status: 'blocked',
          replanRequest: { needed: true, reason: 'Additional validation is required before final closeout.' },
        },
      },
    );
  }

  const candidateCount = readSecurityOpsFlagNumber(params.ctx, 'candidateFindingCount');
  const reportableCount = readSecurityOpsFlagNumber(params.ctx, 'reportableFindingCount');
  const workflowDiscipline = readSecurityOpsFlagString(params.ctx, 'workflowDiscipline');
  const complianceReporting =
    workflowDiscipline === 'compliance' || hasSecurityOpsFlagObject(params.ctx, 'complianceAssessment');
  if (
    params.status === 'completed' &&
    candidateCount === 0 &&
    reportableCount === 0 &&
    !complianceReporting &&
    !params.closeoutOutcome
  ) {
    return handoffGateFailure(
      'zero_finding_reporting_closeout_required',
      'reporting completed with zero candidate/reportable findings requires closeoutOutcome="no_findings_after_coverage", "interim_blocked", or "needs_operator_input".',
      {
        suggestedTool: 'reporting_handoff_preflight',
        currentState: { candidateFindingCount: candidateCount, reportableFindingCount: reportableCount },
        expectedShape: {
          closeoutOutcome: ['no_findings_after_coverage', 'interim_blocked', 'needs_operator_input'],
        },
        repairExample: {
          status: 'completed',
          closeoutOutcome: 'no_findings_after_coverage',
        },
      },
    );
  }

  return null;
};

export const getString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

export const getStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;

export const normalizeValidationLeadPriority = (value: unknown): 'critical' | 'high' | 'medium' | 'low' | undefined => {
  const normalized = getString(value)?.toLowerCase();
  return normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low'
    ? normalized
    : undefined;
};

export const normalizeValidationLead = (
  target: Record<string, unknown>,
  params: { phaseKey: string; handoffRef: string },
): Record<string, unknown> => {
  const method = getString(target.method)?.toUpperCase();
  const pathValue = getString(target.path) ?? getString(target.url);
  const targetValue = getString(target.target) ?? getString(target.url) ?? pathValue;
  const riskFamily =
    getString(target.riskFamily) ??
    getString(target.risk_family) ??
    getString(target.family) ??
    getString(target.type) ??
    'validation';
  const hypothesis =
    getString(target.hypothesis) ??
    `Prior ${params.phaseKey} handoff identified ${method ? `${method} ` : ''}${pathValue ?? targetValue ?? 'a target'} for validation.`;
  const evidenceRefs = uniqueLinks([
    params.handoffRef,
    ...(getStringArray(target.evidenceRefs) ?? []),
    ...(getStringArray(target.evidence_refs) ?? []),
  ]);

  return {
    source: getString(target.source) ?? `phase-handoff:${params.phaseKey}`,
    ...(normalizeValidationLeadPriority(target.priority) ? { priority: normalizeValidationLeadPriority(target.priority) } : {}),
    riskFamily,
    ...(targetValue ? { target: targetValue } : {}),
    ...(method ? { method } : {}),
    ...(pathValue ? { path: pathValue } : {}),
    ...(getString(target.parameter) ? { parameter: getString(target.parameter) } : {}),
    hypothesis,
    ...(getStringArray(target.requiredControls) ? { requiredControls: getStringArray(target.requiredControls) } : {}),
    ...(getStringArray(target.requiredPrerequisites)
      ? { requiredPrerequisites: getStringArray(target.requiredPrerequisites) }
      : {}),
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
    status: getString(target.status) ?? 'open',
  };
};

export const materializeValidationTargets = async (
  ctx: ToolContext,
  params: {
    phaseKey: string;
    handoffRef: string;
    validationTargets?: Array<Record<string, unknown>>;
  },
): Promise<string[]> => {
  if (!params.validationTargets || params.validationTargets.length === 0) {
    return [];
  }
  const session = ctx.sessionStore.get(ctx.sessionId);
  const userId = typeof session?.userId === 'string' ? session.userId : undefined;
  if (!userId) {
    return [];
  }

  const context = resolveSecurityOpsToolContext(ctx);
  const noteIds: string[] = [];
  for (const target of params.validationTargets) {
    const lead = normalizeValidationLead(target, {
      phaseKey: params.phaseKey,
      handoffRef: params.handoffRef,
    });
    const result = await securityOpsService.reportNote({
      userId,
      workspaceDir: ctx.workspaceDir,
      sessionId: ctx.sessionId,
      context,
      input: {
        ntype: 'validation.lead',
        title: `${String(lead.riskFamily)} lead from ${params.phaseKey} handoff`,
        data: lead,
        evidence: [{ path: params.handoffRef, label: 'phase handoff' }],
      },
    });
    // D10 - the lead is canonical and already persisted; its prompt is a projection of it.
    // Record the projection only once it is verified readable, so the lead never advertises
    // a file that is not there. A lead without a prompt is still workable from canonical
    // state, which is exactly what validation fell back to in run r1.
    try {
      const rendered = await leadPromptRenderer.render({
        leadId: result.noteId,
        workspaceDir: ctx.workspaceDir,
        data: lead,
      });
      await securityOpsService.updateValidationLeadPromptMetadata({
        userId,
        context,
        leadId: result.noteId,
        promptSha256: rendered.promptSha256,
        promptPath: rendered.promptPath,
        normalizedLead: rendered.normalizedLead,
      });
      if (ctx.trace) {
        void ctx.trace
          .write(ctx.sessionId, ctx.turnNumber ?? 0, {
            event: 'validation.lead_prompt_rendered',
            severity: 'info',
            payload: {
              leadId: result.noteId,
              promptPath: rendered.promptPath,
              promptSha256: rendered.promptSha256,
              skillSlug: rendered.skillSlug,
              methodologyPath: rendered.methodologyPath,
            },
            note: `rendered validation lead prompt ${result.noteId}`,
          })
          .catch(() => {});
      }
    } catch (error: unknown) {
      if (ctx.trace) {
        void ctx.trace
          .write(ctx.sessionId, ctx.turnNumber ?? 0, {
            event: 'validation.lead_prompt_projection_failed',
            severity: 'warn',
            payload: {
              leadId: result.noteId,
              reason: error instanceof Error ? error.message : String(error),
            },
            note: `validation lead ${result.noteId} has no readable prompt projection`,
          })
          .catch(() => {});
      }
    }
    noteIds.push(result.noteId);
  }
  return noteIds;
};

export type ScannerIngestDebt = {
  parser: string;
  artifactPath: string;
  command: string;
  jobId?: string;
  budgetExceeded?: boolean;
  maxScannerWallSeconds?: number;
  partialIngestionSuggested?: boolean;
  partialIngested?: boolean;
};

export const SUPPORTED_SCANNER_PARSERS = new Set([
  'subfinder',
  'naabu',
  'httpx',
  'nuclei',
  'sqlmap',
  'semgrep',
  'trivy',
  'gitleaks',
  'trufflehog',
  'nmap',
  'ffuf',
  'katana',
  'dalfox',
]);

export const normalizeWorkspaceArtifactPath = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  let normalized = value.trim().replace(/\\/g, '/').replace(/[),.;]+$/u, '');
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('/workspace/')) {
    normalized = normalized.slice('/workspace/'.length);
  } else if (normalized.startsWith('workspace/')) {
    normalized = normalized.slice('workspace/'.length);
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (!normalized.startsWith('.artifacts/')) {
    return undefined;
  }
  return normalized;
};

export const extractScannerParser = (command: string): string | undefined => {
  const segments = command
    .toLowerCase()
    .split(/\r?\n|&&|;|\|\|/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const [firstToken] = segment.split(/\s+/u);
    const parser = firstToken?.replace(/(?:\.exe|\.cmd)$/u, '');
    if (parser && SUPPORTED_SCANNER_PARSERS.has(parser)) {
      return parser;
    }
  }
  return undefined;
};

export const extractScannerArtifactPaths = (command: string): string[] =>
  uniqueLinks(
    (command.match(/(?:\/workspace\/\.artifacts|\.artifacts)\/[^\s"'<>|`]+/giu) ?? [])
      .map(normalizeWorkspaceArtifactPath)
      .filter((value): value is string => Boolean(value))
      .filter((value) => /\.(?:json|jsonl|xml|ya?ml|txt|csv|sarif)$/iu.test(value)),
  );

/**
 * D9 - the canonical answer to "where is this phase?", computed from records the system
 * already holds. Run r1 ended validation Turn 1 reporting `plan 0/4` while its lead queue was
 * fully resolved, then spent Turn 2 rediscovering that over several 100-second model calls.
 *
 * The model reads this. It does not derive it.
 */
export const derivePhaseState = async (
  ctx: ToolContext,
  phaseKey: string,
  gateFailureCodes: readonly string[],
): Promise<ResolvedPhaseState | null> => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  const userId = typeof session?.userId === 'string' ? session.userId : undefined;
  if (!userId) return null;

  const planSteps = Array.isArray(session?.plan)
    ? session.plan.map((step) => ({
      id: String((step as { id?: unknown }).id ?? ''),
      status: String((step as { status?: unknown }).status ?? 'pending'),
    })).filter((step) => step.id.length > 0)
    : [];

  let leads: Array<{ id: string; status: string; blockerCode?: string | null }> = [];
  try {
    const result = await securityOpsService.queryNotes({
      userId,
      context: resolveSecurityOpsToolContext(ctx),
      input: { ntype: 'validation.lead', limit: 200 },
    });
    leads = result.notes.map((note) => {
      const data = getValidationLeadData(note);
      return {
        id: note.id,
        status: getValidationLeadStatus(note),
        blockerCode: getString(data.blockerCode) ?? null,
      };
    });
  } catch {
    // A phase with no lead queue still has a plan, and the resolver handles that.
  }

  return resolvePhaseState({ leads, planSteps, gateFailureCodes });
};

export const getSecurityOpsFlags = (ctx: ToolContext): Record<string, unknown> => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  return session?.flags && typeof session.flags.securityops === 'object' && session.flags.securityops !== null
    ? session.flags.securityops as Record<string, unknown>
    : {};
};

export const scannerArtifactResolutionKey = (parser: string | undefined, artifactPath: string): string =>
  `${parser?.trim().toLowerCase() || '*'}:${normalizeWorkspaceArtifactPath(artifactPath) ?? artifactPath.trim()}`;

export const getScannerBudgetRecord = (ctx: ToolContext, jobId: string | undefined): Record<string, unknown> | null => {
  if (!jobId) {
    return null;
  }
  const securityops = getSecurityOpsFlags(ctx);
  const scannerBudget = securityops.scannerBudget;
  if (!scannerBudget || typeof scannerBudget !== 'object' || Array.isArray(scannerBudget)) {
    return null;
  }
  const record = (scannerBudget as Record<string, unknown>)[jobId];
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record as Record<string, unknown>
    : null;
};

export const getIngestedScannerArtifactRecords = (ctx: ToolContext): Record<string, unknown>[] => {
  const securityops = getSecurityOpsFlags(ctx);
  const ingested = Array.isArray(securityops.ingestedScannerArtifacts)
    ? securityops.ingestedScannerArtifacts
    : [];
  return ingested.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item));
};

export const hasPartialScannerIngest = (ctx: ToolContext, parser: string | undefined, artifactPath: string): boolean => {
  const key = scannerArtifactResolutionKey(parser, artifactPath);
  return getIngestedScannerArtifactRecords(ctx).some((record) => {
    const recordPath = getString(record.artifactPath);
    if (!recordPath || scannerArtifactResolutionKey(getString(record.parser), recordPath) !== key) {
      return false;
    }
    return record.partial === true;
  });
};

export const collectScannerIngestDebts = (ctx: ToolContext): ScannerIngestDebt[] => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  const shellJobs =
    session?.flags && typeof session.flags.shellJobs === 'object' && session.flags.shellJobs !== null
      ? session.flags.shellJobs as Record<string, unknown>
      : {};
  const debts: ScannerIngestDebt[] = [];
  for (const job of Object.values(shellJobs)) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) {
      continue;
    }
    const record = job as Record<string, unknown>;
    const command = getString(record.command);
    if (!command) {
      continue;
    }
    const parser = extractScannerParser(command);
    if (!parser) {
      continue;
    }
    const status = getString(record.status)?.toLowerCase();
    const commandFinished = record.commandFinished !== false;
    if (status === 'running' || status === 'unknown' || !commandFinished) {
      continue;
    }
    const jobId = getString(record.jobId);
    const budget = getScannerBudgetRecord(ctx, jobId);
    for (const artifactPath of extractScannerArtifactPaths(command)) {
      debts.push({
        parser,
        artifactPath,
        command,
        ...(jobId ? { jobId } : {}),
        ...(budget?.budgetExceeded === true ? { budgetExceeded: true } : {}),
        ...(typeof budget?.maxScannerWallSeconds === 'number'
          ? { maxScannerWallSeconds: budget.maxScannerWallSeconds as number }
          : {}),
        ...(budget?.partialIngestionSuggestedAt ? { partialIngestionSuggested: true } : {}),
        ...(hasPartialScannerIngest(ctx, parser, artifactPath) ? { partialIngested: true } : {}),
      });
    }
  }
  const seen = new Set<string>();
  return debts.filter((debt) => {
    const key = scannerArtifactResolutionKey(debt.parser, debt.artifactPath);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const getResolvedScannerArtifactKeys = (
  ctx: ToolContext,
  waivers: readonly { parser?: string; artifactPath: string; reason: string; nextStep: string }[],
): Set<string> => {
  const keys = new Set<string>();
  for (const record of getIngestedScannerArtifactRecords(ctx)) {
    const parser = getString(record.parser);
    const artifactPath = getString(record.artifactPath);
    if (artifactPath) {
      keys.add(scannerArtifactResolutionKey(parser, artifactPath));
    }
  }
  for (const waiver of waivers) {
    keys.add(scannerArtifactResolutionKey(waiver.parser, waiver.artifactPath));
  }
  return keys;
};

export const recordScannerDebtSnapshot = async (
  ctx: ToolContext,
  debts: readonly ScannerIngestDebt[],
  waivers: readonly { parser?: string; artifactPath: string; reason: string; nextStep: string }[],
): Promise<void> => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  if (!session) {
    return;
  }
  const securityops = getSecurityOpsFlags(ctx);
  session.flags = {
    ...(session.flags ?? {}),
    securityops: {
      ...securityops,
      scannerIngestDebts: debts.map((debt) => ({
        parser: debt.parser,
        artifactPath: debt.artifactPath,
        ...(debt.jobId ? { jobId: debt.jobId } : {}),
        ...(debt.budgetExceeded ? { budgetExceeded: true } : {}),
        ...(debt.maxScannerWallSeconds ? { maxScannerWallSeconds: debt.maxScannerWallSeconds } : {}),
        ...(debt.partialIngestionSuggested ? { partialIngestionSuggested: true } : {}),
        ...(debt.partialIngested ? { partialIngested: true } : {}),
      })),
      scannerIngestWaivers: waivers.map((waiver) => ({
        parser: waiver.parser,
        artifactPath: normalizeWorkspaceArtifactPath(waiver.artifactPath) ?? waiver.artifactPath,
        reason: waiver.reason,
        nextStep: waiver.nextStep,
      })),
    },
  };
  await ctx.sessionStore.setAsync(ctx.sessionId, session, 'securityops.scanner_ingest_debt_snapshot');
};

export const evaluateScannerIngestDebtGate = async (
  ctx: ToolContext,
  status: PhaseHandoffStatus,
  waivers: readonly { parser?: string; artifactPath: string; reason: string; nextStep: string }[],
): Promise<PhaseHandoffGateFailure | null> => {
  const debts = collectScannerIngestDebts(ctx);
  await recordScannerDebtSnapshot(ctx, debts, waivers);
  if (status !== 'completed' || debts.length === 0) {
    return null;
  }
  const resolved = getResolvedScannerArtifactKeys(ctx, waivers);
  const unresolved = debts.filter((debt) => !resolved.has(scannerArtifactResolutionKey(debt.parser, debt.artifactPath)));
  if (unresolved.length === 0) {
    return null;
  }
  const details = unresolved
    .slice(0, 5)
    .map((debt) => `${debt.artifactPath} (parser=${debt.parser})`)
    .join('; ');
  return handoffGateFailure(
    'scanner_ingest_debt',
    `submit_phase_handoff blocked: unresolved scanner ingest debt for ${details}. Call ingest_scan_artifact with the expected parser, use partial=true for partial scanner output before re-waiting, or add scannerIngestWaivers with artifactPath, reason, and nextStep.`,
    {
      suggestedTool: 'ingest_scan_artifact',
      currentState: {
        unresolvedScannerIngestDebts: unresolved.map((debt) => ({
          parser: debt.parser,
          artifactPath: debt.artifactPath,
          ...(debt.jobId ? { jobId: debt.jobId } : {}),
          ...(debt.budgetExceeded ? { budgetExceeded: true } : {}),
          ...(debt.partialIngestionSuggested ? { partialIngestionSuggested: true } : {}),
          ...(debt.partialIngested ? { partialIngested: true } : {}),
        })),
        scannerIngestWaivers: waivers,
      },
      expectedShape: {
        ingestedScannerArtifacts: unresolved.map((debt) => ({
          parser: debt.parser,
          artifactPath: debt.artifactPath,
          partial: debt.budgetExceeded ? true : false,
        })),
        scannerIngestWaivers: [{
          parser: 'ffuf',
          artifactPath: '.artifacts/phases/enumeration/ffuf.json',
          reason: 'why ingestion is unnecessary',
          nextStep: 'what replaces this scanner evidence or why coverage is still sufficient',
        }],
      },
      repairExample: {
        scannerIngestWaivers: unresolved.slice(0, 1).map((debt) => ({
          parser: debt.parser,
          artifactPath: debt.artifactPath,
          reason: 'Scanner output was reviewed and contains no ingestable records.',
          nextStep: 'Continue with manual endpoint validation using the discovered inventory.',
        })),
      },
    },
  );
};

export const terminalValidationLeadStatuses = new Set(['validated', 'false_positive', 'blocked', 'deferred', 'superseded']);

export const getValidationLeadData = (note: { data?: unknown }): Record<string, unknown> =>
  note.data && typeof note.data === 'object' && !Array.isArray(note.data)
    ? note.data as Record<string, unknown>
    : {};

export const getValidationLeadStatus = (note: { data?: unknown }): string =>
  getString(getValidationLeadData(note).status)?.toLowerCase() ?? 'open';

export const getSupersededValidationLeadIds = (note: { title?: unknown; data?: unknown }): string[] => {
  const data = getValidationLeadData(note);
  const ids = [
    getString(data.supersedesLeadId),
    getString(data.supersededLeadId),
    getString(data.originalLeadId),
    ...(getStringArray(data.supersedesLeadIds) ?? []),
  ].filter((id): id is string => Boolean(id));
  const title = getString(note.title);
  const titleMatch = title?.match(/\blead\s+([0-9a-f]{8,})\b/iu);
  if (titleMatch?.[1]) {
    ids.push(titleMatch[1].toLowerCase());
  }
  return Array.from(new Set(ids));
};

export const leadIdIsSupersededBy = (leadId: string, supersededIds: ReadonlySet<string>): boolean => {
  if (supersededIds.has(leadId)) {
    return true;
  }
  const lowerLeadId = leadId.toLowerCase();
  return Array.from(supersededIds).some((id) => lowerLeadId.startsWith(id.toLowerCase()));
};

export const evaluateRenderedLeadDispositionGate = async (
  ctx: ToolContext,
  phaseKey: RunPhaseKey,
  status: PhaseHandoffStatus,
): Promise<PhaseHandoffGateFailure | null> => {
  if (phaseKey !== 'validation' || status !== 'completed') {
    return null;
  }
  const securityops = getSecurityOpsFlags(ctx);
  const leadIds = Array.isArray(securityops.openValidationLeadIds)
    ? securityops.openValidationLeadIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (leadIds.length === 0) {
    return null;
  }
  const session = ctx.sessionStore.get(ctx.sessionId);
  const userId = typeof session?.userId === 'string' ? session.userId : undefined;
  if (!userId) {
    return null;
  }
  const result = await securityOpsService.queryNotes({
    userId,
    context: resolveSecurityOpsToolContext(ctx),
    input: { ntype: 'validation.lead', limit: Math.max(leadIds.length * 4, 100) },
  });
  const terminalSupersededLeadIds = new Set<string>();
  for (const note of result.notes) {
    if (!terminalValidationLeadStatuses.has(getValidationLeadStatus(note))) {
      continue;
    }
    for (const supersededId of getSupersededValidationLeadIds(note)) {
      terminalSupersededLeadIds.add(supersededId);
    }
  }
  const openRendered = result.notes.filter((note) => {
    if (!leadIds.includes(note.id)) {
      return false;
    }
    if (leadIdIsSupersededBy(note.id, terminalSupersededLeadIds)) {
      return false;
    }
    return !terminalValidationLeadStatuses.has(getValidationLeadStatus(note));
  });
  if (openRendered.length === 0) {
    return null;
  }
  const details = openRendered
    .slice(0, 5)
    .map((note) => {
      const data = getValidationLeadData(note);
      return `${note.id}${getString(data.riskFamily) ? ` (${getString(data.riskFamily)})` : ''}`;
    })
    .join(', ');
  return handoffGateFailure(
    'open_validation_leads',
    `validation cannot complete while rendered validation leads remain open: ${details}. Use submit_validation_lead_outcome to set each validation.lead status to validated, false_positive, blocked, deferred, or superseded; or submit blocked/replan.`,
    {
      suggestedTool: 'submit_validation_lead_outcome',
      currentState: {
        openValidationLeadIds: openRendered.map((note) => note.id),
        openValidationLeads: openRendered.map((note) => {
          const data = getValidationLeadData(note);
          return {
            leadId: note.id,
            riskFamily: getString(data.riskFamily),
            promptPath: getString(data.promptPath),
            promptSha256: getString(data.promptSha256),
          };
        }),
        renderedValidationLeadIds: leadIds,
      },
      expectedShape: {
        validationLeadStatus: ['validated', 'false_positive', 'blocked', 'deferred', 'superseded'],
        alternativeHandoff: { status: 'blocked', replanRequest: { needed: true } },
      },
      repairExample: {
        status: 'blocked',
        summary: 'Validation could not complete because priority validation leads remain open.',
        replanRequest: { needed: true, reason: 'Resolve open validation.lead records before completion.' },
      },
    },
  );
};

export const evaluateValidationFindingDispositionGate = async (
  ctx: ToolContext,
  phaseKey: RunPhaseKey,
  status: PhaseHandoffStatus,
): Promise<PhaseHandoffGateFailure | null> => {
  if (phaseKey !== 'validation' || status !== 'completed') {
    return null;
  }
  const securityops = getSecurityOpsFlags(ctx);
  const touchedCandidateIds = Array.isArray(securityops.candidateFindingIds)
    ? uniqueLinks(securityops.candidateFindingIds.filter((id): id is string => typeof id === 'string'))
    : [];
  if (touchedCandidateIds.length === 0) {
    return null;
  }
  const session = ctx.sessionStore.get(ctx.sessionId);
  const userId = typeof session?.userId === 'string' ? session.userId : undefined;
  if (!userId) {
    return null;
  }

  const result = await securityOpsService.queryFindings({
    userId,
    context: resolveSecurityOpsToolContext(ctx),
    input: { state: 'all', severity: 'all' },
  });
  const candidateSet = new Set(touchedCandidateIds);
  const unclosed = result.findings.filter((finding) =>
    candidateSet.has(finding.id)
    && (finding.state === 'potential' || finding.state === 'verifying' || finding.state === 'not_reproduced')
  );
  if (unclosed.length === 0) {
    return null;
  }

  const details = unclosed
    .slice(0, 5)
    .map((finding) => `${finding.id} (${finding.severity}: ${finding.title})`)
    .join(', ');
  return handoffGateFailure(
    'unclosed_validation_findings',
    `validation cannot complete while candidate Risks touched by this session remain potential or verifying: ${details}. report_finding(validatesFindingId=...) attaches evidence but does not confirm the Risk; call submit_validation_outcome for each touched Risk. Use outcome=validated only when fresh evidence reproduces the issue, false_positive only when scoped validation disproves the claim with required prerequisites available, and inconclusive when the test cannot decide.`,
    {
      suggestedTool: 'submit_validation_outcome',
      currentState: {
        touchedCandidateFindingIds: touchedCandidateIds,
        openRiskIds: unclosed.map((finding) => finding.id),
        openRisks: unclosed.map((finding) => ({
          findingId: finding.id,
          title: finding.title,
          severity: finding.severity,
          state: finding.state,
          missingReportFields: finding.missingReportFields,
        })),
      },
      expectedShape: {
        validationFindingOutcome: ['validated', 'false_positive', 'inconclusive'],
      },
      repairExample: {
        findingId: unclosed[0]?.id ?? '<finding-id>',
        outcome: 'validated',
        reason: 'Fresh validation-phase evidence reproduced the issue.',
        evidence: [{ path: '/workspace/.artifacts/validation/<proof>.txt', label: 'fresh reproduction evidence' }],
      },
    },
  );
};

export const evaluateFocusedDispositionOutcomeGate = (
  ctx: ToolContext,
  phaseKey: RunPhaseKey,
): PhaseHandoffGateFailure | null => {
  if (phaseKey !== 'validation') {
    return null;
  }
  const securityops = getSecurityOpsFlags(ctx);
  const requestId = getString(securityops.findingDispositionVerificationId);
  if (!requestId || securityops.findingDispositionOutcomeSubmitted === true) {
    return null;
  }
  return handoffGateFailure(
    'missing_finding_disposition_outcome',
    'This focused verification cannot close until submit_finding_disposition_outcome records a typed proof-carrying result. If replay is blocked or cannot decide the claim, submit outcome=inconclusive with a precise blockerCode.',
    {
      suggestedTool: 'submit_finding_disposition_outcome',
      currentState: {
        verificationId: requestId,
        findingId: getString(securityops.findingId),
        requestedState: getString(securityops.requestedRiskState),
        outcomeSubmitted: false,
      },
      expectedShape: {
        outcome: ['fixed', 'still_present', 'false_positive', 'validated', 'inconclusive'],
        proof: {
          claim: 'exact historical claim tested',
          replayAttempted: true,
          prerequisitesSatisfied: true,
          evidenceIds: ['fresh-session-evidence-ref'],
          controlEvidenceIds: ['fresh-prerequisite-evidence-ref'],
        },
      },
    },
  );
};

const extractStringArray = (record: Record<string, unknown> | undefined, key: string): string[] => {
  const value = record?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
};

const getComplianceAssessmentRecordFromFlags = (ctx: ToolContext): Record<string, unknown> | undefined => {
  const securityops = getSecurityOpsFlags(ctx);
  const assessment = securityops.complianceAssessment;
  return assessment && typeof assessment === 'object' && !Array.isArray(assessment)
    ? assessment as Record<string, unknown>
    : undefined;
};

const extractProofObligationIds = (assessment: Record<string, unknown> | undefined): string[] => {
  const fromIds = extractStringArray(assessment, 'proofObligationIds');
  const fromObjects = Array.isArray(assessment?.proofObligations)
    ? assessment.proofObligations
        .map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>).id : undefined))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const legacy = typeof assessment?.proofObligationId === 'string' && assessment.proofObligationId.trim().length > 0
    ? [assessment.proofObligationId]
    : [];
  return Array.from(new Set([...fromIds, ...fromObjects, ...legacy]));
};

const getComplianceAssessmentFrameworkKey = (assessment: Record<string, unknown> | undefined): ComplianceFrameworkKey =>
  isComplianceFrameworkKey(assessment?.framework) ? assessment.framework : 'soc2';

const canonicalFrameworkControlId = (frameworkKey: ComplianceFrameworkKey, value: string): string => {
  const trimmed = value.trim();
  return FRAMEWORK_REGISTRY[frameworkKey]?.controls
    .find((candidate) => candidate.id.toLowerCase() === trimmed.toLowerCase())?.id ?? trimmed;
};

const uniqueCanonicalFrameworkControlIds = (
  frameworkKey: ComplianceFrameworkKey,
  values: readonly string[],
): string[] =>
  Array.from(new Set(values.map((value) => canonicalFrameworkControlId(frameworkKey, value)).filter((value) => value.length > 0)));

const uniqueProofObligationIds = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)));

const evidenceReviewObligationId = (frameworkKey: ComplianceFrameworkKey, controlId: string): string =>
  `evidence-review:${frameworkKey}:${controlId.toLowerCase()}`;

const allFrameworkProofObligationIds = (frameworkKey: ComplianceFrameworkKey): string[] =>
  uniqueProofObligationIds(
    (FRAMEWORK_REGISTRY[frameworkKey]?.controls ?? []).flatMap((control) => [
      control.proofObligation?.id ?? '',
      evidenceReviewObligationId(frameworkKey, control.id),
    ]),
  );

const textIncludesToken = (text: string, token: string): boolean =>
  text.includes(token.trim().toLowerCase());

const extractControlAssessmentSelectionFromText = (
  frameworkKey: ComplianceFrameworkKey,
  text: string,
): { frameworkKey: ComplianceFrameworkKey; controlIds: string[]; proofObligationIds: string[] } => {
  const normalizedText = text.toLowerCase();
  return {
    frameworkKey,
    controlIds: Array.from(new Set(
      (FRAMEWORK_REGISTRY[frameworkKey]?.controls ?? [])
        .filter((control) => textIncludesToken(normalizedText, control.id))
        .map((control) => control.id),
    )),
    proofObligationIds: allFrameworkProofObligationIds(frameworkKey)
      .filter((proofId) => textIncludesToken(normalizedText, proofId)),
  };
};

const resolveControlAssessmentSelection = async (
  ctx: ToolContext,
  activePhase: ActiveRunPhase,
): Promise<{ frameworkKey: ComplianceFrameworkKey; controlIds: string[]; proofObligationIds: string[] }> => {
  const assessment = getComplianceAssessmentRecordFromFlags(ctx);
  const frameworkKey = getComplianceAssessmentFrameworkKey(assessment);
  const flagControlIds = extractStringArray(assessment, 'controlIds');
  const flagProofObligationIds = extractProofObligationIds(assessment);
  if (flagControlIds.length > 0) {
    return {
      frameworkKey,
      controlIds: uniqueCanonicalFrameworkControlIds(frameworkKey, flagControlIds),
      proofObligationIds: uniqueProofObligationIds(flagProofObligationIds),
    };
  }

  const runRows = await db
    .select({ missionEnvelope: runs.missionEnvelope })
    .from(runs)
    .where(eq(runs.id, activePhase.runId))
    .limit(1);
  const missionEnvelope = runRows[0]?.missionEnvelope;
  const missionEnvelopeRecord = missionEnvelope && typeof missionEnvelope === 'object' && !Array.isArray(missionEnvelope)
    ? missionEnvelope as Record<string, unknown>
    : undefined;
  const missions = normalizeMissionEnvelopeNodes(missionEnvelopeRecord?.missions ?? missionEnvelope);
  const phaseStepIds = new Set(Array.isArray(activePhase.stepIds) ? activePhase.stepIds : []);
  const phaseMissionText = missions
    .filter((mission) => phaseStepIds.size === 0 || phaseStepIds.has(mission.id))
    .filter((mission) => mission.phase === 'control_assessment' || phaseStepIds.has(mission.id))
    .map((mission) => [
      mission.question,
      mission.whyReadyNow,
      mission.expectedArtifact,
      mission.stopCondition,
      ...mission.requiredEvidence,
    ].join(' '))
    .join(' ');
  return extractControlAssessmentSelectionFromText(frameworkKey, phaseMissionText);
};

export const evaluateControlAssessmentChecksGate = async (
  ctx: ToolContext,
  activePhaseKey: RunPhaseKey,
  activePhase: ActiveRunPhase,
  status: PhaseHandoffStatus,
): Promise<PhaseHandoffGateFailure | null> => {
  if (activePhaseKey !== 'control_assessment' || status !== 'completed') {
    return null;
  }

  const selection = await resolveControlAssessmentSelection(ctx, activePhase);
  if (selection.controlIds.length === 0) {
    return null;
  }
  const session = ctx.sessionStore.get(ctx.sessionId);
  const userId = typeof session?.userId === 'string' ? session.userId : undefined;
  if (!userId) {
    return handoffGateFailure(
      'missing_control_checks',
      'control_assessment cannot complete because the current session has no user id to verify recorded control checks.',
      { suggestedTool: 'record_control_check' },
    );
  }

  const readiness = await securityOpsService.queryComplianceReadiness({
    userId,
    context: resolveSecurityOpsToolContext(ctx),
    input: { framework: selection.frameworkKey, includeEvidence: false, limit: 200 },
  });
  const controls = readiness.frameworks.find((framework) => framework.key === selection.frameworkKey)?.controls ?? [];
  // Canonicalize the parsed selection against the catalog (case-insensitive) and
  // de-duplicate. Mission text can carry casing/duplicate variants (e.g. "cc6.1"
  // alongside "CC6.1"); without this the gate would demand a check for a variant
  // the backend can never record, making the phase unsatisfiable and leaving the
  // session stuck in a stop-correction loop.
  const canonicalSelectedControlIds = Array.from(
    new Set(
      selection.controlIds
        .map((controlId) => controls.find((candidate) => candidate.id.toLowerCase() === controlId.trim().toLowerCase())?.id)
        .filter((controlId): controlId is string => Boolean(controlId)),
    ),
  );
  const missingControlIds = canonicalSelectedControlIds.filter((controlId) => {
    const control = controls.find((candidate) => candidate.id === controlId);
    const hasFreshCheck = (control?.controlChecks ?? []).some((check) => check.runId === activePhase.runId && check.fresh);
    const actionRequests = Array.isArray((control as { actionRequests?: unknown } | undefined)?.actionRequests)
      ? ((control as { actionRequests?: Array<{ runId?: string | null; status?: string | null }> }).actionRequests ?? [])
      : [];
    const hasActionableRequest = actionRequests.some((request) =>
      ['open', 'fulfilled', 'insufficient', 'contradicted', 'reviewed'].includes(request.status ?? '')
    );
    return !hasFreshCheck && !hasActionableRequest;
  });
  if (canonicalSelectedControlIds.length === 0 || missingControlIds.length === 0) {
    return null;
  }

  return handoffGateFailure(
    'missing_control_checks',
    `control_assessment cannot complete until every selected control has a fresh record_control_check or an existing actionable record_control_request. Missing terminal action: ${missingControlIds.join(', ')}.`,
    {
      suggestedTool: 'record_control_check',
      currentState: {
        selectedControlIds: canonicalSelectedControlIds,
        missingControlIds,
        proofObligationIds: selection.proofObligationIds,
      },
      expectedShape: {
        record_control_check: {
          frameworkKey: selection.frameworkKey,
          controlId: '<one missing selected control id>',
          proofObligationId: '<matching selected proof obligation id>',
          verdict: 'pass|fail|needs_context|not_attempted',
        },
        record_control_request: {
          frameworkKey: selection.frameworkKey,
          controlId: '<one missing selected control id>',
          requestType: 'evidence|access|context|remediation',
          title: '<specific missing item>',
          reason: '<why this blocks an honest control verdict>',
          requestedEvidence: ['<concrete evidence, access, context, or remediation needed>'],
        },
      },
      repairExample: {
        frameworkKey: selection.frameworkKey,
        controlId: missingControlIds[0] ?? '<control-id>',
        proofObligationId: selection.proofObligationIds[0] ?? '<proof-obligation-id>',
        verdict: 'needs_context',
        reasonCode: 'missing_credentials',
        reason: 'Required role credentials were not available, so the control could not be tested honestly.',
      },
    },
  );
};

export const phaseHandoffPreflightToolName = (phaseKey: RunPhaseKey): string =>
  phaseKey === 'planning' ? 'submit_phase_handoff' : `${phaseKey}_handoff_preflight`;

export const withDefaultHandoffSuggestedTool = (
  failure: PhaseHandoffGateFailure,
  phaseKey: RunPhaseKey,
): PhaseHandoffGateFailure => ({
  ...failure,
  suggestedTool: failure.suggestedTool ?? phaseHandoffPreflightToolName(phaseKey),
});

export const evaluateActivePhaseGate = (
  ctx: ToolContext,
  parsed: Pick<ParsedPhaseHandoff, 'phaseId' | 'phase'>,
  activePhase: ActiveRunPhase | null | undefined,
): PhaseHandoffGateFailure | null => {
  if (!activePhase) {
    return handoffGateFailure(
      'active_phase_missing',
      'submit_phase_handoff requires an active run phase for this session',
      {
        currentState: { sessionId: ctx.sessionId, activePhase: null },
        expectedShape: { activePhase: { id: 'uuid', phaseKey: 'canonical Pentest, Compliance, or Code Review phase key' } },
      },
    );
  }
  if (parsed.phaseId && parsed.phaseId !== activePhase.id) {
    return handoffGateFailure(
      'active_phase_id_mismatch',
      `phaseId does not match active phase ${activePhase.id}`,
      {
        currentState: { phaseId: parsed.phaseId, activePhaseId: activePhase.id },
        expectedShape: { phaseId: activePhase.id },
        repairExample: { phaseId: activePhase.id },
      },
    );
  }
  if (parsed.phase && parsed.phase !== activePhase.phaseKey) {
    return handoffGateFailure(
      'active_phase_key_mismatch',
      `phase does not match active phase ${activePhase.phaseKey}`,
      {
        currentState: { phase: parsed.phase, activePhaseKey: activePhase.phaseKey },
        expectedShape: { phase: activePhase.phaseKey },
        repairExample: { phase: activePhase.phaseKey },
      },
    );
  }
  return null;
};

export const evaluatePhaseHandoffGates = async (
  ctx: ToolContext,
  parsed: ParsedPhaseHandoff,
  activePhase: ActiveRunPhase | null | undefined,
  options: { collectAll?: boolean } = {},
): Promise<PhaseHandoffGateFailure[]> => {
  const failures: PhaseHandoffGateFailure[] = [];
  const push = (failure: PhaseHandoffGateFailure | null | undefined): boolean => {
    if (!failure) {
      return false;
    }
    failures.push(failure);
    return !options.collectAll;
  };

  if (push(evaluateActivePhaseGate(ctx, parsed, activePhase))) {
    return failures;
  }
  if (!activePhase) {
    return failures;
  }

  const activePhaseKey = normalizePhaseKey(activePhase.phaseKey) ?? 'recon';
  const replanRequested = parsed.replanRequest?.needed === true;
  const operatorActionRequired = parsed.operatorActionRequired?.needed === true;

  const recommendedSkillGate = await evaluateRecommendedSkillsGate({
    recommendedNextSkills: parsed.recommendedNextSkills,
    recommendedNextPhase: parsed.recommendedNextPhase,
    replanRequested,
  });
  if (push(recommendedSkillGate ? withDefaultHandoffSuggestedTool(recommendedSkillGate, activePhaseKey) : null)) {
    return failures;
  }

  if (push(evaluateTerminalReportingGate({
    ctx,
    phaseKey: activePhaseKey,
    status: parsed.status,
    recommendedNextPhase: parsed.recommendedNextPhase,
    recommendedNextSkills: parsed.recommendedNextSkills,
    closeoutOutcome: parsed.closeoutOutcome,
    replanRequested,
    operatorActionRequired,
  }))) {
    return failures;
  }

  if (push(await evaluateLiveWorkerTaskGate(ctx))) {
    return failures;
  }

  const scannerDebtGate = await evaluateScannerIngestDebtGate(
    ctx,
    parsed.status,
    parsed.scannerIngestWaivers,
  );
  if (push(scannerDebtGate ? withDefaultHandoffSuggestedTool(scannerDebtGate, activePhaseKey) : null)) {
    return failures;
  }

  const leadDispositionGate = await evaluateRenderedLeadDispositionGate(
    ctx,
    activePhaseKey,
    parsed.status,
  );
  if (push(leadDispositionGate ? withDefaultHandoffSuggestedTool(leadDispositionGate, activePhaseKey) : null)) {
    return failures;
  }

  const focusedDispositionGate = evaluateFocusedDispositionOutcomeGate(ctx, activePhaseKey);
  if (push(focusedDispositionGate)) {
    return failures;
  }

  const validationFindingGate = await evaluateValidationFindingDispositionGate(
    ctx,
    activePhaseKey,
    parsed.status,
  );
  if (push(validationFindingGate ? withDefaultHandoffSuggestedTool(validationFindingGate, activePhaseKey) : null)) {
    return failures;
  }

  const controlAssessmentChecksGate = await evaluateControlAssessmentChecksGate(
    ctx,
    activePhaseKey,
    activePhase,
    parsed.status,
  );
  if (push(controlAssessmentChecksGate ? withDefaultHandoffSuggestedTool(controlAssessmentChecksGate, activePhaseKey) : null)) {
    return failures;
  }

  if (activePhaseKey === 'review_validation' && parsed.status === 'completed') {
    const [row] = await db
      .select({ count: count() })
      .from(codeReviewFindings)
      .where(
        and(
          eq(codeReviewFindings.runId, activePhase.runId),
          eq(codeReviewFindings.state, 'candidate'),
        ),
      );
    const openCandidates = Number(row?.count ?? 0);
    if (push(openCandidates > 0
      ? handoffGateFailure(
          'unpublished_code_review_candidates',
          `review_validation cannot complete while ${openCandidates} Code Review candidate(s) remain unresolved`,
          {
            suggestedTool: 'query_code_review_findings',
            currentState: { openCandidates },
            expectedShape: { openCandidates: 0 },
          },
        )
      : null)) {
      return failures;
    }
  }

  if (activePhaseKey === 'review_reporting' && parsed.status === 'completed') {
    const [report] = await db
      .select({ id: codeReviewReports.id })
      .from(codeReviewReports)
      .where(eq(codeReviewReports.runId, activePhase.runId))
      .limit(1);
    if (push(!report
      ? handoffGateFailure(
          'missing_code_review_report',
          'review_reporting cannot complete until finalize_code_review_report persists the standalone report',
          {
            suggestedTool: 'finalize_code_review_report',
            currentState: { reportFinalized: false },
            expectedShape: { reportFinalized: true },
          },
        )
      : null)) {
      return failures;
    }
  }

  return failures;
};

export const renderHandoffGateNudge = (state: PhaseHandoffGateFailureState): string => {
  const expected = state.gate.expectedShape
    ? `\nExpected shape: ${JSON.stringify(state.gate.expectedShape)}`
    : '';
  const repair = state.gate.repairExample
    ? `\nRepair example: ${JSON.stringify(state.gate.repairExample)}`
    : '';
  const repeated = state.circuitBreaker
    ? '\nThis same gate has failed repeatedly. Stop retrying the same completed handoff; use the suggested tool, submit a blocked/replan handoff, or request operator input.'
    : '';
  return [
    'PHASE HANDOFF REPAIR REQUIRED',
    `The last ${state.toolName} attempt was rejected by gate "${state.code}" (${state.count} consecutive failure(s)).`,
    state.message,
    state.gate.suggestedTool ? `Suggested next tool: ${state.gate.suggestedTool}` : undefined,
    `Last rejected payload: ${JSON.stringify(state.lastRejectedPayload)}`,
    expected.trimStart(),
    repair.trimStart(),
    repeated.trimStart(),
  ]
    .filter((line): line is string => Boolean(line && line.trim().length > 0))
    .join('\n');
};

export const recordPhaseHandoffGateTrace = (
  ctx: ToolContext,
  state: PhaseHandoffGateFailureState,
): void => {
  const recorder = ctx.trace;
  if (!recorder) {
    return;
  }
  void recorder
    .write(ctx.sessionId, ctx.turnNumber ?? 0, {
      event: 'phase_handoff.gate_blocked',
      severity: 'warn',
      payload: {
        toolName: state.toolName,
        code: state.code,
        count: state.count,
        circuitBreaker: state.circuitBreaker,
        gate: state.gate,
      },
      note: `${state.toolName} blocked by ${state.code}`,
    })
    .catch(() => {});
};

export const getLifecycleGateFailures = (flags: SessionFlags | undefined): Record<string, unknown> => {
  const raw = flags?.lifecycleGateFailures;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
};

export const getPreviousHandoffGateState = (
  flags: SessionFlags | undefined,
  key: string,
): PhaseHandoffGateFailureState | undefined => {
  const raw = getLifecycleGateFailures(flags).phaseHandoff;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const state = raw as Partial<PhaseHandoffGateFailureState>;
  return state.key === key && typeof state.count === 'number'
    ? state as PhaseHandoffGateFailureState
    : undefined;
};

export const recordPhaseHandoffGateFailure = async (
  ctx: ToolContext,
  toolName: string,
  failure: PhaseHandoffGateFailure,
  parsed: ParsedPhaseHandoff,
): Promise<PhaseHandoffGateFailureState | undefined> => {
  const session = ctx.sessionStore.get(ctx.sessionId);
  if (!session) {
    return undefined;
  }
  const key = `${toolName}:${failure.code}`;
  const previous = getPreviousHandoffGateState(session.flags, key);
  const count = (previous?.count ?? 0) + 1;
  const state: PhaseHandoffGateFailureState = {
    key,
    toolName,
    code: failure.code,
    count,
    message: failure.message,
    lastRejectedAt: Date.now(),
    lastRejectedPayload: compactJsonPreview(parsed),
    gate: failure,
    circuitBreaker: count >= PHASE_HANDOFF_CIRCUIT_BREAKER_THRESHOLD,
  };
  session.flags = {
    ...(session.flags ?? {}),
    lifecycleGateFailures: {
      ...getLifecycleGateFailures(session.flags),
      phaseHandoff: state,
    },
    ...(count >= PHASE_HANDOFF_REPAIR_NUDGE_THRESHOLD ? { ephemeralNudge: renderHandoffGateNudge(state) } : {}),
  };
  await ctx.sessionStore.setAsync(ctx.sessionId, session, 'securityops.phase_handoff_gate_blocked');
  recordPhaseHandoffGateTrace(ctx, state);
  return state;
};

export const writePhaseArtifact = async (
  workspaceDir: string,
  kind: 'phase-handoffs' | 'phase-checkpoints',
  phaseId: string,
  payload: unknown,
): Promise<{ relativePath: string; absolutePath: string }> => {
  const relativePath = path.join('.artifacts', kind, `${phaseId}.json`).replace(/\\/g, '/');
  const absolutePath = path.resolve(workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { relativePath, absolutePath };
};

export const buildPreflightDraft = (
  phaseKey: RunPhaseKey,
  input: z.infer<typeof phaseHandoffPreflightSchema>,
  activePhase: ActiveRunPhase | null | undefined,
): ParsedPhaseHandoff =>
  phaseHandoffSchema.parse({
    ...input,
    phaseId: input.phaseId ?? activePhase?.id,
    phase: input.phase ?? phaseKey,
    status: input.status ?? 'completed',
    summary: input.summary ?? `Preflight ${phaseKey} handoff.`,
  });

export const buildHandoffPayloadSkeleton = (
  phaseKey: RunPhaseKey,
  activePhase: ActiveRunPhase | null | undefined,
): Record<string, unknown> => ({
  phaseId: activePhase?.id ?? '<active-phase-id>',
  phase: activePhase?.phaseKey ?? phaseKey,
  status: 'completed',
  summary: '<concise phase outcome>',
  completedObjectives: [],
  unresolvedQuestions: [],
  artifacts: [],
  canonicalWrites: {
    notes: [],
    findings: [],
    assets: [],
    services: [],
  },
  evidenceRefs: [],
  ...(phaseKey === 'reporting' ? { closeoutOutcome: 'no_findings_after_coverage' } : {}),
});

export const collectScannerDebtState = (
  ctx: ToolContext,
  waivers: readonly { parser?: string; artifactPath: string; reason: string; nextStep: string }[],
): Record<string, unknown> => {
  const debts = collectScannerIngestDebts(ctx);
  const resolved = getResolvedScannerArtifactKeys(ctx, waivers);
  const normalizedDebts = debts.map((debt) => ({
    parser: debt.parser,
    artifactPath: debt.artifactPath,
    ...(debt.jobId ? { jobId: debt.jobId } : {}),
    ...(debt.budgetExceeded ? { budgetExceeded: true } : {}),
    ...(debt.maxScannerWallSeconds ? { maxScannerWallSeconds: debt.maxScannerWallSeconds } : {}),
    ...(debt.partialIngestionSuggested ? { partialIngestionSuggested: true } : {}),
    ...(debt.partialIngested ? { partialIngested: true } : {}),
  }));
  const unresolved = debts
    .filter((debt) => !resolved.has(scannerArtifactResolutionKey(debt.parser, debt.artifactPath)))
    .map((debt) => ({
      parser: debt.parser,
      artifactPath: debt.artifactPath,
      ...(debt.jobId ? { jobId: debt.jobId } : {}),
      ...(debt.budgetExceeded ? { budgetExceeded: true } : {}),
      ...(debt.maxScannerWallSeconds ? { maxScannerWallSeconds: debt.maxScannerWallSeconds } : {}),
      ...(debt.partialIngestionSuggested ? { partialIngestionSuggested: true } : {}),
      ...(debt.partialIngested ? { partialIngested: true } : {}),
    }));
  const securityops = getSecurityOpsFlags(ctx);
  const budgetRecords = securityops.scannerBudget && typeof securityops.scannerBudget === 'object' && !Array.isArray(securityops.scannerBudget)
    ? Object.values(securityops.scannerBudget as Record<string, unknown>)
      .filter((record): record is Record<string, unknown> =>
        Boolean(record) && typeof record === 'object' && !Array.isArray(record))
      .map((record) => ({
        jobId: getString(record.jobId),
        scannerFamily: getString(record.scannerFamily),
        phaseKey: getString(record.phaseKey),
        status: getString(record.status),
        elapsedMs: typeof record.elapsedMs === 'number' ? record.elapsedMs : undefined,
        maxScannerWallSeconds: typeof record.maxScannerWallSeconds === 'number' ? record.maxScannerWallSeconds : undefined,
        budgetExceeded: record.budgetExceeded === true,
        partialIngestionSuggested: Boolean(record.partialIngestionSuggestedAt),
        partialIngestionSuggestion: record.partialIngestionSuggestion,
      }))
    : [];
  return {
    total: normalizedDebts.length,
    unresolvedCount: unresolved.length,
    debts: normalizedDebts,
    unresolved,
    budgetExceededCount: budgetRecords.filter((record) => record.budgetExceeded).length,
    scannerBudget: budgetRecords,
  };
};

export const listCompatibleSkillSlugs = async (phaseKey: RunPhaseKey): Promise<string[]> => {
  const catalog = await skillLoader.loadSkillCatalog();
  return catalog
    .filter((skill) => !phaseProfileRegistry.validateSkillAssignment(phaseKey, skill))
    .map((skill) => skill.slug)
    .sort((left, right) => left.localeCompare(right));
};

export const buildPhaseHandoffPreflightSchema = (phaseKey: RunPhaseKey): ToolImpl['meta']['schema'] => ({
  type: 'object',
  properties: {
    phaseId: { type: 'string' },
    phase: { type: 'string', description: `Defaults to ${phaseKey}.` },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'], description: 'Defaults to completed.' },
    summary: { type: 'string' },
    completedObjectives: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    artifacts: { type: 'array', items: { type: 'string' } },
    canonicalWrites: {
      type: 'object',
      properties: {
        notes: { type: 'array', items: { type: 'string' } },
        findings: { type: 'array', items: { type: 'string' } },
        assets: { type: 'array', items: { type: 'string' } },
        services: { type: 'array', items: { type: 'string' } },
      },
    },
    evidenceRefs: { type: 'array', items: { type: 'string' } },
    validationQueue: { type: 'array', items: { type: 'string' } },
    validationTargets: { type: 'array', items: { type: 'object' } },
    scannerIngestWaivers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          parser: { type: 'string' },
          artifactPath: { type: 'string' },
          reason: { type: 'string' },
          nextStep: { type: 'string' },
        },
        required: ['artifactPath', 'reason', 'nextStep'],
      },
    },
    recommendedNextPhase: {
      type: 'string',
      enum: ['recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting'],
      description: 'Optional canonical next phase. Omit this field for terminal reporting closeout; do not send an empty string.',
    },
    recommendedNextSkills: { type: 'array', items: { type: 'string' } },
    closeoutOutcome: {
      type: 'string',
      enum: ['no_findings_after_coverage', 'interim_blocked', 'needs_operator_input'],
    },
    replanRequest: {
      type: 'object',
      properties: {
        needed: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['needed'],
    },
    operatorActionRequired: {
      type: 'object',
      properties: {
        needed: { type: 'boolean' },
        request: { type: 'string' },
      },
      required: ['needed'],
    },
  },
  required: [],
});

