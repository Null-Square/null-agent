import { z, ZodError } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/db/client';
import { findings, type RunWorkflowDiscipline } from '@/db/schema';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import {
  buildOmittedMissionObligationsMessage,
  findOmittedMissionObligations,
} from '@/domains/security-ops/runs/missionObligations';
import { RunService } from '@/domains/security-ops/runs/RunService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { fromToolImpl } from '@/domains/agent-brain/application/tools/helpers';
import { getSessionFromContext } from '@/domains/agent-brain/application/tools/runtime/ToolContextSelectors';
import { runWithGuards } from '@/domains/agent-brain/application/tools/runtime/ToolRunner';
import type { ToolImpl } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import { applyTerminal, checkSessionTerminal } from '@/domains/agent-brain/application/terminal/TerminalActionLayer';
import { resolveSecurityOpsToolContext } from './securityopsContext';
import { validateRunTitleFromPlan } from '@/domains/security-ops/runs/planTitle';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';
import { notifyAppEvent } from '@/domains/platform/notifications/notificationService';
import { buildUserNotificationTarget } from '@/shared/notifications/userNotificationTarget';
import { logger } from '@/shared/logger';
import {
  normalizeMissionEnvelopeNodes,
  serializeMissionEnvelopeNode,
  type MissionEnvelopeNode,
} from '@/domains/agent-brain/domain/workers/missionEnvelope';
import {
  attachMissionPhases,
  phaseProfileRegistry,
  type RunPhaseKey,
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import {
  COMPLIANCE_FRAMEWORK_KEYS,
  FRAMEWORK_LABELS,
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
} from '@/domains/security-ops/compliance/frameworks';
import { isComplianceFrameworkKey } from '@/domains/security-ops/compliance/profile';
import { getHostedRunPersistencePort } from '@/domains/security-ops/runs/HostedRunPersistencePort';
import {
  findMissionToolCapabilityFailures,
  findSkillToolCapabilityFailures,
  isPhaseReplanSubmission,
} from '@/domains/security-ops/runs/MissionAdmissionPolicy';

const submitPlanSchema = z.object({
  plan: z.string().min(1, 'plan is required'),
  skillSlugs: z.array(z.string().min(1)).optional(),
  missions: z
    .array(
      z.object({
        id: z.string().min(1, 'mission id is required'),
        phase: z
          .enum(['planning', 'recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting'], {
            errorMap: () => ({
              message:
                'phase must be an exact canonical Pentest, Compliance, or Code Review phase key (planning is reserved for the planner). Variants are not accepted.',
            }),
          })
          .optional(),
        question: z.string().min(1, 'question is required'),
        why_ready_now: z.string().min(1, 'why_ready_now is required'),
        required_evidence: z.array(z.string().min(1)).min(1, 'required_evidence is required'),
        expected_artifact: z.string().min(1, 'expected_artifact is required'),
        stop_condition: z.string().min(1, 'stop_condition is required'),
        assigned_skills: z.array(z.string().min(1)).optional(),
        parallel_safe_with: z.array(z.string().min(1)).optional(),
        revalidates_finding_id: z.string().uuid().optional(),
      }),
    )
    .optional(),
  retriedApproaches: z
    .array(
      z.object({
        technique: z.string().min(1, 'technique is required'),
        endpoint: z.string().min(1, 'endpoint is required'),
        new_hypothesis: z.string().optional(),
      }),
    )
    .optional(),
});

const runService = new RunService(db, new OrganizationService(db), new ScopeService(db));
const skillLoader = new SkillLoader();

const formatToolError = (error: unknown): string => {
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

const compactPlanTraceText = (value: unknown, maxLength = 500): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\s+/gu, ' ');
  if (!trimmed) return undefined;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
};

const inferSubmitPlanGateCode = (error: string): string => {
  const lower = error.toLowerCase();
  if (lower.includes('planning prechecks incomplete')) return 'missing_precheck';
  if (lower.includes('requires a user-visible markdown plan')) return 'invalid_mission_envelope';
  if (lower.includes('title')) return 'invalid_plan_title';
  if (lower.includes('unknown skillslug') || lower.includes('unknown skill')) return 'unknown_skill';
  if (lower.includes('planner-only skillslug')) return 'planner_only_skill';
  if (lower.includes('novelty')) return 'novelty_gate_failed';
  if (lower.includes('missions[] is required') || lower.includes('mission')) return 'invalid_mission_envelope';
  if (lower.includes('not compatible') || lower.includes('assigned_skills')) return 'skill_phase_mismatch';
  if (lower.includes('revalidates_finding_id')) return 'validation_target_missing';
  return 'submit_plan_rejected';
};

const correctionHintFromGate = (gateCode: string): string | undefined => {
  switch (gateCode) {
    case 'missing_precheck':
      return 'Run the required planning precheck query tools before submitting the plan.';
    case 'unknown_skill':
      return 'Use a skill slug from the active skill catalog or remove the unknown skill.';
    case 'skill_phase_mismatch':
      return 'Move the skill to a compatible phase or select a phase-compatible skill.';
    case 'invalid_mission_envelope':
      return 'Submit complete mission nodes with required evidence, artifact, stop condition, and assigned skills.';
    case 'novelty_gate_failed':
      return 'Add a new hypothesis for retried blocked approaches or avoid repeating the prior blocker.';
    case 'validation_target_missing':
      return 'Use an existing finding id from this scope or remove the revalidation reference.';
    default:
      return undefined;
  }
};

const traceSubmitPlanGateBlocked = (
  ctx: ToolContext,
  error: string,
  args: unknown,
  extra: Record<string, unknown> = {},
): void => {
  const gateCode = typeof extra.gateCode === 'string'
    ? extra.gateCode
    : inferSubmitPlanGateCode(error);
  ctx.trace?.write?.(ctx.sessionId, ctx.turnNumber ?? 0, {
    event: 'submit_plan.gate_blocked',
    severity: 'warn',
    payload: {
      gateCode,
      reason: error,
      correctionHint: correctionHintFromGate(gateCode),
      rejectedPlanSummary: compactPlanTraceText((args as { plan?: unknown } | undefined)?.plan),
      ...extra,
    },
    note: compactPlanTraceText(error, 240) ?? 'submit_plan rejected by harness gate',
  }).catch((traceError) => {
    logger.warn({ err: traceError, sessionId: ctx.sessionId, gateCode }, '[submit_plan] Failed to record gate trace');
  });
};

const blockedSubmitPlan = (
  ctx: ToolContext,
  args: unknown,
  error: string,
  extra?: Record<string, unknown>,
) => {
  traceSubmitPlanGateBlocked(ctx, error, args, extra);
  return { ok: false, data: { error } };
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const parseToolArgs = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const parseJsonObject = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const sessionHasSuccessfulToolCall = (
  session: ReturnType<typeof getSessionFromContext>,
  toolName: string,
  predicate?: (args: Record<string, unknown> | undefined) => boolean,
): boolean => {
  if (!session) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  let revisionStart = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const source = typeof message?.metadata?.source === 'string' ? message.metadata.source : '';
    if (message?.role === 'user' && (source === 'plan_feedback' || source === 'phase_replan_request')) {
      revisionStart = index + 1;
    }
  }
  const revisionMessages = messages.slice(revisionStart);
  const successfulCalls = new Map<string, string>();
  for (const message of revisionMessages) {
    const receipt = message.metadata?.toolExecution;
    if (message.role !== 'tool' || receipt?.outcome !== 'succeeded') continue;
    const callId = receipt.toolCallId ?? message.tool_call_id ?? message.toolCallId;
    if (typeof callId === 'string' && callId.length > 0) {
      successfulCalls.set(callId, receipt.toolName);
    }
  }
  for (const msg of revisionMessages) {
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const call of calls) {
      if (call?.function?.name !== toolName) continue;
      if (successfulCalls.get(call.id) !== toolName) continue;
      const args = parseToolArgs(call.function.arguments);
      if (!predicate || predicate(args)) {
        return true;
      }
    }
  }
  return false;
};

/**
 * D13 - reads the run's phases so the omitted-obligation rule can be enforced before the
 * plan is dispatched. A read failure must never turn into a false refusal: the workflow
 * service still enforces the same rule downstream.
 */
const submitPlanPhaseRepository = new RunPhaseRepository(db);

/**
 * True when this submission revises an existing plan rather than establishing the first one.
 * Only a revision can drop an obligation, so only a revision needs the check — and an initial
 * plan does not pay for a query that can only ever return nothing.
 */
const isPlanRevision = (session: ReturnType<typeof getSessionFromContext>): boolean => {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  return messages.some((message) => {
    const source = typeof message?.metadata?.source === 'string' ? message.metadata.source : '';
    return message?.role === 'user'
      && (source === 'plan_feedback' || source === 'phase_replan_request');
  });
};

const findOmittedMissionObligationsForRun = async (
  runId: string,
  revisedMissionIds: readonly string[],
): Promise<string[]> => {
  try {
    const phases = await submitPlanPhaseRepository.listByRunId(runId);
    return findOmittedMissionObligations(phases, revisedMissionIds);
  } catch {
    return [];
  }
};

const hasStrategicNtype = (
  expectedNtype: 'run.digest' | 'approach.tried' | 'approach.blocker' | 'scan.coverage',
) =>
  (args: Record<string, unknown> | undefined): boolean =>
    normalizeText(args?.ntype) === expectedNtype;

type BlockedApproach = {
  technique: string;
  endpoint: string;
  normalizedTechnique: string;
  normalizedEndpoint: string;
};

type SubmitPlanArgs = z.infer<typeof submitPlanSchema>;
const MISSION_ENVELOPE_HEADING_PATTERN = /^##+\s+mission envelope\s*$/im;
const REPORTING_SKILL_SLUG = 'security-reporting';
const COMPLIANCE_CONTROL_SKILL_SLUG = 'compliance-access-control';
const COMPLIANCE_TECHNICAL_READINESS_SKILL_SLUG = 'compliance-technical-readiness';
const COMPLIANCE_EVIDENCE_REVIEW_SKILL_SLUG = 'compliance-evidence-review';
const COMPLIANCE_GOVERNANCE_REVIEW_SKILL_SLUG = 'compliance-governance-review';
const COMPLIANCE_REPORTING_SKILL_SLUG = 'compliance-reporting';
const COMPLIANCE_ASSESSMENT_SKILL_SLUGS = [
  COMPLIANCE_CONTROL_SKILL_SLUG,
  COMPLIANCE_TECHNICAL_READINESS_SKILL_SLUG,
  COMPLIANCE_EVIDENCE_REVIEW_SKILL_SLUG,
  COMPLIANCE_GOVERNANCE_REVIEW_SKILL_SLUG,
] as const;
const COMPLIANCE_EXECUTOR_SKILL_SLUGS = [
  ...COMPLIANCE_ASSESSMENT_SKILL_SLUGS,
  COMPLIANCE_REPORTING_SKILL_SLUG,
] as const;
const CODE_REVIEW_PHASE_ROUTING = [
  { phase: 'review_mapping', skill: 'code-review-mapping' },
  { phase: 'review_analysis', skill: 'code-review-analysis' },
  { phase: 'review_validation', skill: 'code-review-validation' },
  { phase: 'review_reporting', skill: 'code-review-reporting' },
] as const;
const CODE_REVIEW_EXECUTOR_SKILL_SLUGS = CODE_REVIEW_PHASE_ROUTING.map(
  ({ skill }) => skill,
);
const DEFAULT_COMPLIANCE_CONTROL_IDS = ['CC6.1'];
const DEFAULT_COMPLIANCE_PROOF_OBLIGATION_IDS = ['soc2-cc6.1-authz-v1'];
const INTERNAL_PLAN_METADATA_LABELS = [
  'confidence',
  'skill',
  'skills',
  'assigned skill',
  'assigned skills',
  'assigned_skill',
  'assigned_skills',
  'required evidence',
  'expected artifact',
  'done when',
  'stop condition',
  'parallel safe with',
  'parallel_safe_with',
  'revalidates finding id',
  'revalidates_finding_id',
  'methodology',
  'methodology path',
  'methodology paths',
  'internal routing note',
  'internal routing notes',
];
const INTERNAL_PLAN_LINE_CONTENT_PATTERNS = [/\bplaybook\b/i, /\bskills?\b/i];

const normalizePlanLineForMetadataCheck = (line: string): string =>
  line
    .replace(/[*_`~]/g, '')
    .trim()
    .toLowerCase();

const MARKDOWN_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

const getMarkdownHeading = (line: string): { level: number; text: string } | null => {
  const match = MARKDOWN_HEADING_PATTERN.exec(line.trim());
  if (!match) return null;
  const marker = match[1] ?? '';
  const text = normalizePlanLineForMetadataCheck(match[2] ?? '').replace(/:$/, '');
  return { level: marker.length, text };
};

const isInternalPlanMetadataHeading = (line: string): boolean => {
  const heading = getMarkdownHeading(line);
  return Boolean(heading && heading.level > 1 && INTERNAL_PLAN_METADATA_LABELS.includes(heading.text));
};

const isInternalPlanMetadataLine = (line: string): boolean => {
  const normalized = normalizePlanLineForMetadataCheck(line);
  if (!normalized) {
    return false;
  }

  const lineWithoutBullet = normalized.replace(/^[-*+]\s+/, '');
  return INTERNAL_PLAN_METADATA_LABELS.some((label) => lineWithoutBullet.startsWith(`${label}:`));
};

const isInternalPlanContentLine = (
  line: string,
  disallowedSkillSlugs: readonly string[],
): boolean => {
  const normalized = normalizePlanLineForMetadataCheck(line);
  if (!normalized) {
    return false;
  }

  return (
    INTERNAL_PLAN_LINE_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    disallowedSkillSlugs.some((slug) => normalized.includes(slug.toLowerCase()))
  );
};

const stripExistingMissionEnvelopeSection = (plan: string): string => {
  const match = plan.match(MISSION_ENVELOPE_HEADING_PATTERN);
  if (!match || match.index === undefined) {
    return plan.trim();
  }
  return plan.slice(0, match.index).trim();
};

const sanitizeDisplayPlan = (plan: string, disallowedSkillSlugs: readonly string[] = []): string =>
  stripExistingMissionEnvelopeSection(plan)
    .split(/\r?\n/)
    .filter(
      (line) => {
        const heading = getMarkdownHeading(line);
        if (heading?.level === 1) {
          return true;
        }

        return (
          !isInternalPlanMetadataHeading(line) &&
          !isInternalPlanMetadataLine(line) &&
          !isInternalPlanContentLine(line, disallowedSkillSlugs)
        );
      },
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const buildMissionEnvelopePayload = (missions: MissionEnvelopeNode[]): Record<string, unknown> | null =>
  missions.length > 0
    ? { missions: missions.map(serializeMissionEnvelopeNode) }
    : null;

const missionUsesReportingSkill = (mission: MissionEnvelopeNode): boolean =>
  (mission.assignedSkills ?? []).some((slug) => normalizeText(slug) === REPORTING_SKILL_SLUG);

const uniqueSkillSlugs = (skillSlugs: string[] | undefined): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of skillSlugs ?? []) {
    const normalized = normalizeText(slug);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const ensureReportingSkillSlug = (
  parsed: SubmitPlanArgs,
  isNonPentestSession: boolean,
): SubmitPlanArgs => {
  if (isNonPentestSession || !parsed.missions || parsed.missions.length === 0) {
    return parsed;
  }

  return {
    ...parsed,
    skillSlugs: uniqueSkillSlugs([...(parsed.skillSlugs ?? []), REPORTING_SKILL_SLUG]),
  };
};

const getApproachTriedCallIds = (
  session: ReturnType<typeof getSessionFromContext>,
): Set<string> => {
  const callIds = new Set<string>();
  if (!session) return callIds;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const msg of messages) {
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const call of calls) {
      if (call?.function?.name !== 'query_notes') continue;
      const args = parseToolArgs(call.function.arguments);
      if (hasStrategicNtype('approach.tried')(args)) {
        callIds.add(call.id);
      }
    }
  }
  return callIds;
};

const extractNotesFromToolResult = (content: string | undefined): Record<string, unknown>[] => {
  const payload = parseJsonObject(content);
  const data = payload?.data;
  const notes = Array.isArray((data as Record<string, unknown> | undefined)?.notes)
    ? ((data as Record<string, unknown>).notes as unknown[])
    : Array.isArray(payload?.notes)
      ? (payload.notes as unknown[])
      : [];
  return notes.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object');
};

const extractBlockedApproaches = (
  session: ReturnType<typeof getSessionFromContext>,
): BlockedApproach[] => {
  if (!session) return [];
  const approachTriedCallIds = getApproachTriedCallIds(session);
  if (approachTriedCallIds.size === 0) return [];

  const blocked = new Map<string, BlockedApproach>();
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const toolCallId = msg.tool_call_id ?? msg.toolCallId;
    if (!toolCallId || !approachTriedCallIds.has(toolCallId)) continue;

    const notes = extractNotesFromToolResult(msg.content);
    for (const note of notes) {
      const data = note.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      const result = normalizeText((data as Record<string, unknown>).result);
      if (result !== 'blocked') continue;

      const technique = String((data as Record<string, unknown>).technique ?? '').trim();
      const endpoint = String((data as Record<string, unknown>).endpoint ?? '').trim();
      const normalizedTechnique = normalizeText(technique);
      const normalizedEndpoint = normalizeText(endpoint);
      if (!normalizedTechnique || !normalizedEndpoint) continue;

      blocked.set(`${normalizedTechnique}::${normalizedEndpoint}`, {
        technique,
        endpoint,
        normalizedTechnique,
        normalizedEndpoint,
      });
    }
  }

  return Array.from(blocked.values());
};

const validateNoveltyGate = (
  session: ReturnType<typeof getSessionFromContext>,
  parsed: SubmitPlanArgs,
): string | null => {
  const retriedApproaches = parsed.retriedApproaches ?? [];
  for (const retried of retriedApproaches) {
    if (!retried.new_hypothesis?.trim()) {
      return (
        'submit_plan blocked: retriedApproaches entries require new_hypothesis content. ' +
        `Fix (${JSON.stringify({ technique: retried.technique, endpoint: retried.endpoint })}) and submit again.`
      );
    }
  }

  const blockedApproaches = extractBlockedApproaches(session);
  if (blockedApproaches.length === 0) {
    return null;
  }

  const normalizedPlan = parsed.plan.trim().toLowerCase();
  const retriedIndex = new Map(
    retriedApproaches.map((entry) => [
      `${normalizeText(entry.technique)}::${normalizeText(entry.endpoint)}`,
      entry,
    ]),
  );

  for (const blocked of blockedApproaches) {
    if (
      !normalizedPlan.includes(blocked.normalizedTechnique) ||
      !normalizedPlan.includes(blocked.normalizedEndpoint)
    ) {
      continue;
    }

    const matchingRetry = retriedIndex.get(`${blocked.normalizedTechnique}::${blocked.normalizedEndpoint}`);
    if (!matchingRetry) {
      return (
        'submit_plan blocked: plan appears to retry a previously blocked approach ' +
        `(technique="${blocked.technique}" endpoint="${blocked.endpoint}") without a new_hypothesis. ` +
        'Either choose a different approach or provide retriedApproaches[{ technique, endpoint, new_hypothesis }] ' +
        'explaining what is different this time.'
      );
    }
  }

  return null;
};

const extractRunGoal = (extraContext: string | undefined): string | undefined => {
  if (!extraContext) {
    return undefined;
  }
  const match = extraContext.match(/^=== RUN GOAL ===\s*\r?\n([\s\S]*?)(?:\r?\n\r?\n=== [A-Z0-9 _-]+ ===|$)/m);
  return match?.[1]?.trim() || undefined;
};

const NON_RECON_GOAL_PATTERN =
  /\b(validat|repro|confirm|exploit|poc|vulnerab|assessment|pentest|auth|idor|sqli|sql injection|xss|ssrf|rce|csrf|traversal|bypass|cve-\d{4}-\d+|finding)\b/i;
const FOLLOW_UP_MISSION_PATTERN =
  /\b(validat|repro|confirm|exploit|poc|vulnerab|evidence|reportable|promote|replan|checkpoint|triage|analy[sz]e)\b/i;

const CODE_REVIEW_MISSION_PHASES = new Set([
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
]);

export const validatePentestMissionEnvelope = (
  session: ReturnType<typeof getSessionFromContext>,
  parsed: SubmitPlanArgs,
): { error: string } | { missions: MissionEnvelopeNode[] } => {
  const missions = attachMissionPhases(normalizeMissionEnvelopeNodes(parsed.missions));
  if (missions.length === 0) {
    return {
      error:
        'submit_plan blocked: missions[] is required. Include graph-lite mission nodes with id, question, why_ready_now, required_evidence, expected_artifact, stop_condition, assigned_skills, and optional parallel_safe_with.',
    };
  }
  const foreignPhase = missions.find((mission) =>
    CODE_REVIEW_MISSION_PHASES.has(mission.phase ?? '') || mission.phase === 'control_assessment',
  );
  if (foreignPhase) {
    return {
      error:
        `submit_plan blocked: Pentest mission "${foreignPhase.id}" cannot use phase=${foreignPhase.phase}. ` +
        'Code Review and Compliance phases require their own explicit workflow discipline.',
    };
  }

  const ids = new Set<string>();
  for (const mission of missions) {
    const normalizedId = mission.id.trim().toLowerCase();
    if (ids.has(normalizedId)) {
      return { error: `submit_plan blocked: duplicate mission id "${mission.id}". Mission ids must be unique.` };
    }
    ids.add(normalizedId);
  }

  for (const mission of missions) {
    for (const referencedId of mission.parallelSafeWith ?? []) {
      if (!ids.has(referencedId.trim().toLowerCase())) {
        return {
          error:
            `submit_plan blocked: mission "${mission.id}" references unknown parallel_safe_with id "${referencedId}".`,
        };
      }
    }
  }

  const assignedSlugs = new Set((parsed.skillSlugs ?? []).map((slug) => normalizeText(slug)));
  for (const mission of missions) {
    for (const skillSlug of mission.assignedSkills ?? []) {
      if (!assignedSlugs.has(normalizeText(skillSlug))) {
        return {
          error:
            `submit_plan blocked: mission "${mission.id}" assigned_skills includes "${skillSlug}" but skillSlugs does not. Add it to skillSlugs or remove it from the mission.`,
        };
      }
    }
  }

  const finalMission = missions[missions.length - 1];
  const finalMissionSkillSlugs = (finalMission?.assignedSkills ?? [])
    .map((slug) => normalizeText(slug))
    .filter((slug) => slug.length > 0);
  if (
    !finalMission ||
    finalMission.phase !== 'reporting' ||
    finalMissionSkillSlugs.length !== 1 ||
    finalMissionSkillSlugs[0] !== REPORTING_SKILL_SLUG
  ) {
    return {
      error:
        'submit_plan blocked: normal SecurityOps runs must end with a dedicated security-reporting closeout mission. Add a final mission with assigned_skills=["security-reporting"], required_evidence tied to this scope\'s canonical findings/coverage/evidence, and a stop_condition covering prepare_report_context, run.digest, authored summary.md/report.md, and finalize_run_artifacts. Reporting is its own phase; do not collapse it into the last test mission.',
    };
  }

  const runGoal = extractRunGoal(session?.extraContext);
  if (
    runGoal &&
    NON_RECON_GOAL_PATTERN.test(runGoal) &&
    !isPhaseReplanSubmission(session?.messages)
  ) {
    const hasFollowUpOrReplan = missions.some((mission) => {
      if (missionUsesReportingSkill(mission)) {
        return false;
      }
      return FOLLOW_UP_MISSION_PATTERN.test(
        [
          mission.question,
          mission.expectedArtifact,
          mission.stopCondition,
          ...mission.requiredEvidence,
        ].join(' '),
      );
    });
    if (!hasFollowUpOrReplan) {
      return {
        error:
          'submit_plan blocked: non-recon goals require at least one follow-up vulnerability-analysis, validation, evidence, or explicit replan checkpoint mission after discovery.',
      };
    }
  }

  return { missions };
};

type ComplianceAssessmentSelection = {
  frameworkKey: ComplianceFrameworkKey;
  frameworkLabel: string;
  requiredControlIds: string[];
  requiredProofObligationIds: string[];
  candidateControlIds: string[];
  candidateProofObligationIds: string[];
  plannerMaySelectControls: boolean;
};

const controlTextIncludes = (text: string, value: string): boolean =>
  text.includes(value.trim().toLowerCase());

const regexEscape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const complianceTokenTextIncludes = (text: string, value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return new RegExp(`(^|[^a-z0-9])${regexEscape(normalized)}($|[^a-z0-9])`, 'iu').test(text);
};

const canonicalFrameworkControlId = (
  frameworkKey: ComplianceFrameworkKey,
  value: string,
): string => {
  const trimmed = value.trim();
  return FRAMEWORK_REGISTRY[frameworkKey]?.controls
    .find((control) => control.id.toLowerCase() === trimmed.toLowerCase())?.id ?? trimmed;
};

const uniqueCanonicalFrameworkControlIds = (
  frameworkKey: ComplianceFrameworkKey,
  values: readonly string[],
): string[] =>
  Array.from(
    new Set(
      values
        .map((value) => canonicalFrameworkControlId(frameworkKey, value))
        .filter((value) => value.trim().length > 0),
    ),
  );

const uniqueProofObligationIds = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean)));

const evidenceReviewObligationId = (frameworkKey: ComplianceFrameworkKey, controlId: string): string =>
  `evidence-review:${frameworkKey}:${controlId.toLowerCase()}`;

const allFrameworkProofObligationIds = (frameworkKey: ComplianceFrameworkKey): string[] =>
  uniqueProofObligationIds(
    (FRAMEWORK_REGISTRY[frameworkKey]?.controls ?? []).flatMap((control) => [
      control.proofObligation?.id ?? '',
      evidenceReviewObligationId(frameworkKey, control.id),
    ]),
  );

const findOffFrameworkComplianceReferences = (
  text: string,
  selectedFrameworkKey: ComplianceFrameworkKey,
): string[] => {
  const matches: string[] = [];
  for (const frameworkKey of COMPLIANCE_FRAMEWORK_KEYS) {
    if (frameworkKey === selectedFrameworkKey) {
      continue;
    }
    const label = FRAMEWORK_LABELS[frameworkKey] ?? frameworkKey;
    if (complianceTokenTextIncludes(text, frameworkKey) || complianceTokenTextIncludes(text, label)) {
      matches.push(`${frameworkKey} framework`);
    }
    for (const control of FRAMEWORK_REGISTRY[frameworkKey]?.controls ?? []) {
      if (complianceTokenTextIncludes(text, control.id)) {
        matches.push(`${frameworkKey}/${control.id}`);
      }
    }
    for (const proofId of allFrameworkProofObligationIds(frameworkKey)) {
      if (complianceTokenTextIncludes(text, proofId)) {
        matches.push(`${frameworkKey}/${proofId}`);
      }
    }
  }
  return Array.from(new Set(matches)).slice(0, 20);
};

const extractControlAssessmentSelectionFromText = (
  text: string,
  selection: ComplianceAssessmentSelection,
): { controlIds: string[]; proofObligationIds: string[] } => {
  const normalizedText = text.toLowerCase();
  const controlIds = (FRAMEWORK_REGISTRY[selection.frameworkKey]?.controls ?? [])
    .filter((control) => controlTextIncludes(normalizedText, control.id))
    .map((control) => control.id);
  const proofUniverse = allFrameworkProofObligationIds(selection.frameworkKey);
  const proofObligationIds = proofUniverse.filter((proofId) => controlTextIncludes(normalizedText, proofId));
  return {
    controlIds: Array.from(new Set(controlIds)),
    proofObligationIds,
  };
};

const validateComplianceMissionEnvelope = (
  parsed: SubmitPlanArgs,
  selection: ComplianceAssessmentSelection,
): { error: string } | { missions: MissionEnvelopeNode[] } => {
  const missions = attachMissionPhases(normalizeMissionEnvelopeNodes(parsed.missions));
  if (missions.length !== 2) {
    return {
      error:
        'submit_plan blocked: compliance assessments require exactly two missions: one control_assessment mission and one compliance-reporting mission. Put bounded inventory/evidence-context work inside control_assessment; do not create a recon mission.',
    };
  }

  const skillSlugs = new Set((parsed.skillSlugs ?? []).map((slug) => normalizeText(slug)));
  const assignedSkillSlugs = new Set(
    missions.flatMap((mission) => (mission.assignedSkills ?? []).map((slug) => normalizeText(slug))),
  );
  for (const slug of assignedSkillSlugs) {
    if (!skillSlugs.has(slug)) {
      return {
        error:
          `submit_plan blocked: mission assigned_skills includes "${slug}" but skillSlugs does not. Add it to skillSlugs or remove it from the mission.`,
      };
    }
  }

  const allowedSkillSlugs = new Set<string>(COMPLIANCE_EXECUTOR_SKILL_SLUGS);
  const selectedAssessmentSkills = COMPLIANCE_ASSESSMENT_SKILL_SLUGS.filter((slug) => skillSlugs.has(slug));
  for (const slug of skillSlugs) {
    if (!allowedSkillSlugs.has(slug)) {
      return {
        error: `submit_plan blocked: compliance assessments may only use ${[...allowedSkillSlugs].join(', ')}; remove ${slug}.`,
      };
    }
  }
  if (selectedAssessmentSkills.length === 0 || !skillSlugs.has(COMPLIANCE_REPORTING_SKILL_SLUG)) {
    return {
      error:
        `submit_plan blocked: compliance assessments must include at least one assessment skill (${COMPLIANCE_ASSESSMENT_SKILL_SLUGS.join(' or ')}) and ${COMPLIANCE_REPORTING_SKILL_SLUG}.`,
    };
  }

  const [controlMission, reportingMission] = missions;
  const allMissionText = missions.flatMap((mission) => [
    mission.id,
    mission.question,
    mission.whyReadyNow,
    mission.expectedArtifact,
    mission.stopCondition,
    ...mission.requiredEvidence,
  ]).join(' ').toLowerCase();
  const offFrameworkReferences = findOffFrameworkComplianceReferences(allMissionText, selection.frameworkKey);
  if (offFrameworkReferences.length > 0) {
    return {
      error:
        `submit_plan blocked: this run is scoped to ${selection.frameworkLabel}; remove off-framework references: ${offFrameworkReferences.join(', ')}.`,
    };
  }

  const controlSkills = (controlMission?.assignedSkills ?? []).map((slug) => normalizeText(slug));
  const reportingSkills = (reportingMission?.assignedSkills ?? []).map((slug) => normalizeText(slug));
  if (
    !controlMission ||
    controlMission.phase !== 'control_assessment' ||
    controlSkills.length === 0 ||
    controlSkills.some((slug) => !COMPLIANCE_ASSESSMENT_SKILL_SLUGS.includes(slug as typeof COMPLIANCE_ASSESSMENT_SKILL_SLUGS[number]))
  ) {
    return {
      error:
        `submit_plan blocked: the first compliance mission must have phase=control_assessment and assigned_skills limited to ${COMPLIANCE_ASSESSMENT_SKILL_SLUGS.join(', ')}.`,
    };
  }
  if (
    !reportingMission ||
    reportingMission.phase !== 'reporting' ||
    reportingSkills.length !== 1 ||
    reportingSkills[0] !== COMPLIANCE_REPORTING_SKILL_SLUG
  ) {
    return {
      error:
        'submit_plan blocked: the final compliance mission must have phase=reporting and assigned_skills=[compliance-reporting].',
    };
  }

  const controlText = [
    controlMission.question,
    controlMission.whyReadyNow,
    controlMission.expectedArtifact,
    controlMission.stopCondition,
    ...controlMission.requiredEvidence,
  ].join(' ').toLowerCase();
  const referenced = extractControlAssessmentSelectionFromText(controlText, selection);
  if (selection.plannerMaySelectControls) {
    const unsupportedControlIds = referenced.controlIds.filter((controlId) => !selection.candidateControlIds.includes(controlId));
    const unsupportedProofObligationIds = referenced.proofObligationIds.filter((proofId) => !selection.candidateProofObligationIds.includes(proofId));
    const chosenControlIds = selection.candidateControlIds.filter((controlId) => controlText.includes(controlId.toLowerCase()));
    const chosenProofObligationIds = selection.candidateProofObligationIds.filter((proofId) => controlText.includes(proofId.toLowerCase()));
    if (unsupportedControlIds.length > 0 || unsupportedProofObligationIds.length > 0) {
      return {
        error:
          `submit_plan blocked: the control_assessment mission references unsupported ${selection.frameworkLabel} controls or proof obligations. Supported controls: ${selection.candidateControlIds.join(', ')}. Supported proof obligations: ${selection.candidateProofObligationIds.join(', ')}.`,
      };
    }
    if (chosenControlIds.length === 0 || chosenProofObligationIds.length === 0) {
      return {
        error:
          `submit_plan blocked: the compliance planner must choose at least one supported control and matching proof obligation from ${selection.candidateControlIds.join(', ')}.`,
      };
    }
  } else {
    const missingControlIds = selection.requiredControlIds.filter((controlId) => !controlText.includes(controlId.toLowerCase()));
    const missingProofObligationIds = selection.requiredProofObligationIds.filter((proofId) => !controlText.includes(proofId.toLowerCase()));
    if (missingControlIds.length > 0 || missingProofObligationIds.length > 0) {
      return {
        error:
          `submit_plan blocked: the control_assessment mission must explicitly target all selected controls (${selection.requiredControlIds.join(', ')}) and proof obligations (${selection.requiredProofObligationIds.join(', ')}).`,
      };
    }
  }
  const mentionsControlCheck = controlText.includes('record_control_check');
  const mentionsControlRequest = controlText.includes('record_control_request');
  if (!mentionsControlCheck && !mentionsControlRequest) {
    return {
      error:
        'submit_plan blocked: the control_assessment mission stop condition or required evidence must require record_control_check for tested controls or record_control_request for missing evidence/access/context/remediation.',
    };
  }

  return { missions };
};

export const validateCodeReviewMissionEnvelope = (
  parsed: SubmitPlanArgs,
): { error: string } | { missions: MissionEnvelopeNode[] } => {
  const missions = normalizeMissionEnvelopeNodes(parsed.missions);
  const requiredMissions = CODE_REVIEW_PHASE_ROUTING;
  if (missions.length !== requiredMissions.length) {
    return {
      error:
        'submit_plan blocked: Code Review requires exactly four ordered missions: review_mapping, review_analysis, review_validation, and review_reporting.',
    };
  }

  for (let index = 0; index < requiredMissions.length; index += 1) {
    const required = requiredMissions[index]!;
    const mission = missions[index];
    if (mission?.phase !== required.phase) {
      return {
        error:
          `submit_plan blocked: Code Review mission ${index + 1} must use phase=${required.phase}; Pentest and Compliance phases cannot be mixed into Code Review.`,
      };
    }
    const missionSkills = uniqueSkillSlugs(mission.assignedSkills ?? []);
    if (missionSkills.length !== 1 || missionSkills[0] !== required.skill) {
      return {
        error:
          `submit_plan blocked: Code Review phase=${required.phase} must use assigned_skills=["${required.skill}"] with no Pentest, Compliance, or cross-phase skill fallback.`,
      };
    }
  }

  const requiredSkills = requiredMissions.map(({ skill }) => skill);
  const declaredSkills = uniqueSkillSlugs(parsed.skillSlugs ?? []);
  if (
    declaredSkills.length !== requiredSkills.length
    || requiredSkills.some((skill) => !declaredSkills.includes(skill))
  ) {
    return {
      error:
        `submit_plan blocked: Code Review skillSlugs must contain exactly ${requiredSkills.join(', ')}.`,
    };
  }

  return { missions };
};

/**
 * Code Review has a fixed product workflow, so phase-to-skill routing is
 * runtime-owned metadata rather than a planning decision. Binding it here
 * removes a needless model failure mode while the ordered phase validation
 * remains the authority boundary that prevents Pentest or Compliance mixing.
 */
export const bindCodeReviewMissionRouting = (
  parsed: SubmitPlanArgs,
): SubmitPlanArgs => ({
  ...parsed,
  skillSlugs: [...CODE_REVIEW_EXECUTOR_SKILL_SLUGS],
  missions: parsed.missions?.map((mission) => {
    const route = CODE_REVIEW_PHASE_ROUTING.find(
      ({ phase }) => phase === mission.phase,
    );
    return route
      ? { ...mission, assigned_skills: [route.skill] }
      : mission;
  }),
});

const validatePlannerPrechecks = (session: ReturnType<typeof getSessionFromContext>): string[] => {
  const missing: string[] = [];

  if (!sessionHasSuccessfulToolCall(session, 'query_inventory')) {
    missing.push('query_inventory');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_findings')) {
    missing.push('query_findings');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_notes', hasStrategicNtype('run.digest'))) {
    missing.push('query_notes(ntype=run.digest)');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_notes', hasStrategicNtype('approach.tried'))) {
    missing.push('query_notes(ntype=approach.tried)');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_notes', hasStrategicNtype('approach.blocker'))) {
    missing.push('query_notes(ntype=approach.blocker)');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_notes', hasStrategicNtype('scan.coverage'))) {
    missing.push('query_notes(ntype=scan.coverage)');
  }

  return missing;
};

const validateCompliancePlannerPrechecks = (session: ReturnType<typeof getSessionFromContext>): string[] => {
  const missing: string[] = [];
  if (!sessionHasSuccessfulToolCall(session, 'query_compliance_readiness')) {
    missing.push('query_compliance_readiness');
  }
  if (!sessionHasSuccessfulToolCall(session, 'query_inventory')) {
    missing.push('query_inventory');
  }
  return missing;
};

const isCompliancePlannerSession = (session: ReturnType<typeof getSessionFromContext>): boolean => {
  if (session?.promptProfile === 'compliance-planner') {
    return true;
  }
  const securityops =
    session?.flags && typeof session.flags === 'object' && !Array.isArray(session.flags)
      ? (session.flags.securityops as Record<string, unknown> | undefined)
      : undefined;
  return Boolean(securityops?.complianceAssessment);
};

const isCodeReviewPlannerSession = (session: ReturnType<typeof getSessionFromContext>): boolean =>
  session?.promptProfile === 'code-review-planner';

const readComplianceAssessmentSelection = (
  session: ReturnType<typeof getSessionFromContext>,
): ComplianceAssessmentSelection => {
  const securityops =
    session?.flags && typeof session.flags === 'object' && !Array.isArray(session.flags)
      ? (session.flags.securityops as Record<string, unknown> | undefined)
      : undefined;
  const assessment =
    securityops?.complianceAssessment && typeof securityops.complianceAssessment === 'object' && !Array.isArray(securityops.complianceAssessment)
      ? (securityops.complianceAssessment as Record<string, unknown>)
      : undefined;

  const frameworkKey = isComplianceFrameworkKey(assessment?.framework) ? assessment.framework : 'soc2';
  const frameworkLabel = FRAMEWORK_LABELS[frameworkKey] ?? frameworkKey;
  const rawRequiredControlIds = Array.isArray(assessment?.controlIds)
    ? assessment.controlIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const rawCandidateControlIds = Array.isArray(assessment?.candidateControlIds)
    ? assessment.candidateControlIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const proofObligationIdsFromList = Array.isArray(assessment?.proofObligationIds)
    ? assessment.proofObligationIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const candidateProofObligationIdsFromList = Array.isArray(assessment?.candidateProofObligationIds)
    ? assessment.candidateProofObligationIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const proofObligationIdsFromObjects = Array.isArray(assessment?.proofObligations)
    ? assessment.proofObligations
        .map((value) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const candidateProofObligationIdsFromObjects = Array.isArray(assessment?.candidateProofObligations)
    ? assessment.candidateProofObligations
        .map((value) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined))
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const legacyProofObligationId = typeof assessment?.proofObligationId === 'string' && assessment.proofObligationId.trim().length > 0
    ? [assessment.proofObligationId]
    : [];
  const requiredControlIds = uniqueCanonicalFrameworkControlIds(frameworkKey, rawRequiredControlIds);
  const candidateControlIds = uniqueCanonicalFrameworkControlIds(frameworkKey, rawCandidateControlIds);
  const requiredProofObligationIds = uniqueProofObligationIds([
    ...proofObligationIdsFromList,
    ...proofObligationIdsFromObjects,
    ...legacyProofObligationId,
  ]);
  const fallbackRequiredControlIds = requiredControlIds.length > 0
    ? requiredControlIds
    : frameworkKey === 'soc2'
      ? DEFAULT_COMPLIANCE_CONTROL_IDS
      : [];
  const fallbackRequiredProofObligationIds = requiredProofObligationIds.length > 0
    ? requiredProofObligationIds
    : frameworkKey === 'soc2'
      ? DEFAULT_COMPLIANCE_PROOF_OBLIGATION_IDS
      : [];
  const resolvedCandidateControlIds = candidateControlIds.length > 0
    ? candidateControlIds
    : fallbackRequiredControlIds;
  const resolvedCandidateProofObligationIds = uniqueProofObligationIds([
    ...candidateProofObligationIdsFromList,
    ...candidateProofObligationIdsFromObjects,
    ...(candidateProofObligationIdsFromList.length === 0 && candidateProofObligationIdsFromObjects.length === 0
      ? fallbackRequiredProofObligationIds
      : []),
  ]);

  return {
    frameworkKey,
    frameworkLabel,
    requiredControlIds: Array.from(new Set(fallbackRequiredControlIds)),
    requiredProofObligationIds: fallbackRequiredProofObligationIds,
    candidateControlIds: Array.from(new Set(resolvedCandidateControlIds)),
    candidateProofObligationIds: resolvedCandidateProofObligationIds,
    plannerMaySelectControls: requiredControlIds.length === 0 && candidateControlIds.length > 0,
  };
};

const validateAssignedSkillSlugs = async (skillSlugs: string[] | undefined): Promise<string | null> => {
  if (!skillSlugs || skillSlugs.length === 0) {
    return null;
  }

  const catalog = await skillLoader.loadSkillCatalog();
  const catalogBySlug = new Map(catalog.map((skill) => [normalizeText(skill.slug), skill]));
  const known = new Set(catalogBySlug.keys());
  const unknown = skillSlugs
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0)
    .filter((slug) => !known.has(normalizeText(slug)));

  if (unknown.length > 0) {
    return `submit_plan blocked: unknown skillSlugs: ${unknown.join(', ')}. Remove them or add them to the skill catalog first.`;
  }

  const plannerOnly = skillSlugs
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0)
    .filter((slug) => catalogBySlug.get(normalizeText(slug))?.phase === 'planning');
  if (plannerOnly.length > 0) {
    return `submit_plan blocked: planner-only skillSlugs are not allowed in executor skillSlugs: ${plannerOnly.join(', ')}.`;
  }

  return null;
};

const validateMissionPhaseSkillCompatibility = async (
  missions: MissionEnvelopeNode[],
  workflowDiscipline?: RunWorkflowDiscipline,
): Promise<string | null> => {
  const assignedSkillSlugs = Array.from(
    new Set(
      missions.flatMap((mission) =>
        (mission.assignedSkills ?? [])
          .map((slug) => slug.trim())
          .filter((slug) => slug.length > 0),
      ),
    ),
  );
  if (assignedSkillSlugs.length === 0) {
    return null;
  }

  const catalog = await skillLoader.loadSkillCatalog();
  const catalogBySlug = new Map(catalog.map((skill) => [normalizeText(skill.slug), skill]));
  for (const mission of missions) {
    const phase = mission.phase as RunPhaseKey | undefined;
    if (!phase) {
      return `submit_plan blocked: mission "${mission.id}" is missing a phase.`;
    }
    for (const skillSlug of mission.assignedSkills ?? []) {
      const skill = catalogBySlug.get(normalizeText(skillSlug));
      if (!skill) {
        continue;
      }
      const compatibilityError = phaseProfileRegistry.validateSkillAssignment(phase, skill);
      if (compatibilityError) {
        return `submit_plan blocked: mission "${mission.id}" ${compatibilityError}.`;
      }
      const unavailableTools = findSkillToolCapabilityFailures(
        phase,
        skill.requiredTools ?? [],
        workflowDiscipline,
      );
      if (unavailableTools.length > 0) {
        return (
          `submit_plan blocked: mission "${mission.id}" assigns skill "${skill.slug}" to phase "${phase}", ` +
          `but that phase cannot provide required tools: ${unavailableTools.join(', ')}.`
        );
      }
    }
  }

  return null;
};

const validateRevalidatedFindingIds = async (
  missions: MissionEnvelopeNode[],
  context: ReturnType<typeof resolveSecurityOpsToolContext>,
): Promise<string | null> => {
  const ids = Array.from(
    new Set(
      missions
        .map((mission) => mission.revalidatesFindingId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
  if (ids.length === 0) {
    return null;
  }
  if (!context.organizationId || !context.scopeId) {
    return 'submit_plan blocked: revalidates_finding_id requires organization and scope context.';
  }

  const rows = await db
    .select({ id: findings.id })
    .from(findings)
    .where(
      and(
        eq(findings.organizationId, context.organizationId),
        eq(findings.scopeId, context.scopeId),
        inArray(findings.id, ids),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length > 0
    ? `submit_plan blocked: revalidates_finding_id not found in this scope: ${missing.join(', ')}.`
    : null;
};

export const SubmitPlan: ToolImpl = {
  meta: {
    name: 'submit_plan',
    description:
      'Submit the final planner output for the current run. Include retriedApproaches when you intentionally retry a previously blocked technique+endpoint with a new hypothesis.',
    category: 'securityops',
    schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description:
            'Final user-visible plan document in markdown format. Do not include Mission Envelope JSON, assigned_skills, confidence scores, methodology paths, or internal routing notes here; put executable metadata in missions[].',
        },
        skillSlugs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional skills to assign to the executor workspace. Standalone Code Review routing is fixed and derived by the server.',
        },
        retriedApproaches: {
          type: 'array',
          description:
            'Optional list of previously blocked technique+endpoint pairs you are intentionally retrying, with a new_hypothesis describing what is different this time.',
          items: {
            type: 'object',
            properties: {
              technique: { type: 'string' },
              endpoint: { type: 'string' },
              new_hypothesis: { type: 'string' },
            },
            required: ['technique', 'endpoint', 'new_hypothesis'],
          },
        },
        missions: {
          type: 'array',
          description:
            'Graph-lite mission nodes. Each planned task needs id, phase, question, why_ready_now, required_evidence, expected_artifact, and stop_condition. Include assigned_skills when routing is planner-selected; standalone Code Review routing is derived by the server. parallel_safe_with and revalidates_finding_id are optional.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              phase: {
                type: 'string',
                enum: ['planning', 'recon', 'enumeration', 'validation', 'exploitation', 'evidence', 'control_assessment', 'reporting', 'review_mapping', 'review_analysis', 'review_validation', 'review_reporting'],
                description: 'Execution phase for this mission. Runtime uses this before falling back to skill-based compatibility inference.',
              },
              question: { type: 'string' },
              why_ready_now: { type: 'string' },
              required_evidence: { type: 'array', items: { type: 'string' } },
              expected_artifact: { type: 'string' },
              stop_condition: { type: 'string' },
              assigned_skills: { type: 'array', items: { type: 'string' } },
              parallel_safe_with: { type: 'array', items: { type: 'string' } },
              revalidates_finding_id: {
                type: 'string',
                format: 'uuid',
                description: 'Existing finding UUID in this scope, only for known-finding retest missions.',
              },
            },
            required: ['id', 'question', 'why_ready_now', 'required_evidence', 'expected_artifact', 'stop_condition'],
          },
        },
      },
      required: ['plan'],
    },
    risks: ['write'],
    returns: 'json',
  },
  async run(args, ctx: ToolContext) {
    return runWithGuards(
      SubmitPlan.meta,
      ctx,
      async () => {
        const session = getSessionFromContext(ctx);
        if (session?.agentType !== 'planner') {
          return blockedSubmitPlan(ctx, args, 'submit_plan is only available to planner sessions', {
            gateCode: 'wrong_agent_role',
          });
        }

        const context = resolveSecurityOpsToolContext(ctx);
        if (!context.runId) {
          return blockedSubmitPlan(ctx, args, 'submit_plan requires a run-bound planner session', {
            gateCode: 'missing_run_context',
          });
        }

        const terminal = checkSessionTerminal(session);
        if (terminal.kind === 'plan_submitted') {
          return {
            ok: true,
            data: {
              success: true,
              alreadySubmitted: true,
              terminal: true,
              runId: context.runId,
              nextAction: 'stop',
            },
          };
        }

        const compliancePlannerSession = isCompliancePlannerSession(session);
        const codeReviewPlannerSession =
          context.workflowDiscipline === 'code_review' || isCodeReviewPlannerSession(session);
        const complianceAssessmentSelection = compliancePlannerSession
            ? readComplianceAssessmentSelection(session)
          : {
              frameworkKey: 'soc2' as const,
              frameworkLabel: FRAMEWORK_LABELS.soc2,
              requiredControlIds: DEFAULT_COMPLIANCE_CONTROL_IDS,
              requiredProofObligationIds: DEFAULT_COMPLIANCE_PROOF_OBLIGATION_IDS,
              candidateControlIds: DEFAULT_COMPLIANCE_CONTROL_IDS,
              candidateProofObligationIds: DEFAULT_COMPLIANCE_PROOF_OBLIGATION_IDS,
              plannerMaySelectControls: false,
            };
        const missingPrechecks = codeReviewPlannerSession
          ? []
          : compliancePlannerSession
            ? validateCompliancePlannerPrechecks(session)
            : validatePlannerPrechecks(session);
        if (missingPrechecks.length > 0) {
          return blockedSubmitPlan(
            ctx,
            args,
            `submit_plan blocked: planning prechecks incomplete. Missing required calls: ${missingPrechecks.join(', ')}. ` +
              'Run the required query tools first, then submit the plan.',
            {
              gateCode: 'missing_precheck',
              missingPrechecks,
            },
          );
        }

        try {
          const parsedInput = ensureReportingSkillSlug(
            submitPlanSchema.parse(args),
            compliancePlannerSession || codeReviewPlannerSession,
          );
          const parsed = codeReviewPlannerSession
            ? bindCodeReviewMissionRouting(parsedInput)
            : parsedInput;
          const displayPlan = sanitizeDisplayPlan(parsed.plan, parsed.skillSlugs ?? []);
          if (!displayPlan) {
            return blockedSubmitPlan(ctx, args, 'submit_plan requires a user-visible markdown plan', {
              gateCode: 'invalid_mission_envelope',
            });
          }
          const titleValidationError = validateRunTitleFromPlan(displayPlan);
          if (titleValidationError) {
            return blockedSubmitPlan(ctx, args, titleValidationError, {
              gateCode: 'invalid_plan_title',
            });
          }
          const skillSlugError = await validateAssignedSkillSlugs(parsed.skillSlugs);
          if (skillSlugError) {
            return blockedSubmitPlan(ctx, args, skillSlugError);
          }
          const noveltyError = compliancePlannerSession || codeReviewPlannerSession
            ? null
            : validateNoveltyGate(session, { ...parsed, plan: displayPlan });
          if (noveltyError) {
            return blockedSubmitPlan(ctx, args, noveltyError, {
              gateCode: 'novelty_gate_failed',
            });
          }
          const missionValidation = codeReviewPlannerSession
            ? validateCodeReviewMissionEnvelope(parsed)
            : compliancePlannerSession
              ? validateComplianceMissionEnvelope(parsed, complianceAssessmentSelection)
              : validatePentestMissionEnvelope(session, parsed);
          if ('error' in missionValidation) {
            return blockedSubmitPlan(ctx, args, missionValidation.error, {
              gateCode: 'invalid_mission_envelope',
            });
          }
          const missionWorkflowDiscipline: RunWorkflowDiscipline = codeReviewPlannerSession
            ? 'code_review'
            : compliancePlannerSession
              ? 'compliance'
              : context.workflowDiscipline ?? 'pentest';
          const phaseSkillError = await validateMissionPhaseSkillCompatibility(
            missionValidation.missions,
            missionWorkflowDiscipline,
          );
          if (phaseSkillError) {
            return blockedSubmitPlan(ctx, args, phaseSkillError, {
              gateCode: 'skill_phase_mismatch',
            });
          }
          const missionToolFailures = findMissionToolCapabilityFailures(
            missionValidation.missions,
            missionWorkflowDiscipline,
          );
          if (missionToolFailures.length > 0) {
            const failure = missionToolFailures[0]!;
            return blockedSubmitPlan(
              ctx,
              args,
              `submit_plan blocked: mission "${failure.missionId}" requires ${failure.unavailableTools.join(', ')} ` +
                `in expected_artifact or stop_condition, but phase "${failure.phase}" cannot provide those tools. ` +
                'Move the canonical write to a phase that owns it or change the mission output.',
              {
                gateCode: 'mission_tool_unavailable',
                missionId: failure.missionId,
                phase: failure.phase,
                unavailableTools: failure.unavailableTools,
              },
            );
          }
          const revalidationError = await validateRevalidatedFindingIds(missionValidation.missions, context);
          if (revalidationError) {
            return blockedSubmitPlan(ctx, args, revalidationError, {
              gateCode: 'validation_target_missing',
            });
          }
          // D13 - refuse a replan that drops an unfinished mission obligation here, where the
          // planner can repair it, instead of letting the workflow service throw after the
          // dispatch. Run r1 hit this nine times before the replan was accepted.
          const omittedMissionObligations = isPlanRevision(session)
            ? await findOmittedMissionObligationsForRun(
              context.runId,
              missionValidation.missions.map((mission) => mission.id),
            )
            : [];
          if (omittedMissionObligations.length > 0) {
            return blockedSubmitPlan(
              ctx,
              args,
              buildOmittedMissionObligationsMessage(omittedMissionObligations),
              {
                gateCode: 'omitted_mission_obligations',
                omittedMissionObligations,
              },
            );
          }

          const hostedRun = context.runHost === 'research_lab'
            ? getHostedRunPersistencePort(context.runId)
            : null;
          const updatedRun = hostedRun
            ? await hostedRun.submitPlan({
                runId: context.runId,
                sessionId: ctx.sessionId,
                plan: displayPlan,
                skillSlugs: parsed.skillSlugs ?? [],
                missions: missionValidation.missions,
              })
            : await runService.markPlanningComplete(
                context.runId,
                displayPlan,
                parsed.skillSlugs,
                ctx.sessionId,
                buildMissionEnvelopePayload(missionValidation.missions),
              );
          const awaitingPlanApproval = updatedRun.status === 'awaiting_approval';
          if (awaitingPlanApproval && updatedRun.userId) {
            const target = buildUserNotificationTarget({
              destination: 'run_detail',
              runId: updatedRun.id,
              sessionId: ctx.sessionId,
              ctaLabel: 'Review plan',
              data: {
                reason: 'plan_approval',
                awaitingPlanApproval: true,
              },
            });
            void Promise.resolve()
              .then(() =>
                notifyAppEvent({
                  userId: updatedRun.userId,
                  type: 'action_required',
                  title: updatedRun.title || 'Plan Ready for Review',
                  message: 'The planner submitted a proposed plan. Review it, approve execution, or request changes.',
                  ...(target.link ? { link: target.link } : {}),
                  data: target.data,
                }),
              )
              .catch((error) => {
                logger.warn({ err: error, runId: updatedRun.id, userId: updatedRun.userId }, '[submit_plan] Failed to send plan review notification');
              });
          }

          if (!awaitingPlanApproval) {
            await applyTerminal(session, ctx, 'plan_submitted', { runId: updatedRun.id });
            return {
              ok: true,
              data: {
                runId: updatedRun.id,
                status: updatedRun.status,
                awaitingPlanApproval: false,
                assignedSkillSlugs: updatedRun.assignedSkillSlugs ?? [],
                missionCount: missionValidation.missions.length,
                nextAction: 'runtime will continue with the next ready phase automatically',
              },
            };
          }

          await applyTerminal(session, ctx, 'plan_submitted', { runId: updatedRun.id });
          return {
            ok: true,
            control: {
              kind: 'awaiting_approval',
              reason: 'plan_submission',
              runId: updatedRun.id,
            },
            data: {
              runId: updatedRun.id,
              status: updatedRun.status,
              awaitingPlanApproval,
              assignedSkillSlugs: updatedRun.assignedSkillSlugs ?? [],
              missionCount: missionValidation.missions.length,
            },
          };
        } catch (error) {
          return blockedSubmitPlan(ctx, args, formatToolError(error), {
            gateCode: 'submit_plan_exception',
          });
        }
      },
      {},
      {
        runId: resolveSecurityOpsToolContext(ctx).runId,
      },
    );
  },
};

export const tools: ToolModuleDefinition[] = [SubmitPlan].map(fromToolImpl);
