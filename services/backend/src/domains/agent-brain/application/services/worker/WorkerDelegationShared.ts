import {
  normalizePhaseKey,
  type RunPhaseKey
} from '@/domains/security-ops/runs/PhaseProfileRegistry';
import { SkillLoader } from '@/domains/security-ops/skills/SkillLoader';
import {
  normalizePosixPath,
} from '../../../adapters/workspace/WorkspaceFsAdapter';
import { MemoryManager } from '../../../domain/helpers/MemoryManager';
import type {
  AgentMemory,
  FactCategory,
  MissionEnvelope,
  SessionFlags,
  SessionState,
  ToolAccessPolicy,
  WorkerContinuationMode,
  WorkerDependencyMode,
  WorkerResultArtifact,
  WorkerRunMode,
  WorkerTaskBudget,
  WorkerTaskRecord,
  WorkerToolPreflight,
  WorkerToolPreflightEntry,
  WorkerType,
} from '../../../domain/types';
import { renderMissionEnvelope } from '../../../domain/workers/missionEnvelope';
import {
  WORKER_INHERITED_BLOCK_REASONS,
  type ToolBudgetSnapshot,
  type WorkerTemplate
} from '../../../domain/workers/workerContracts';
import type { AgentEngine } from '../../orchestration/AgentEngine';
import type { OrchestratorAdapter } from '../../orchestration/OrchestratorAdapter';
import { type ToolPolicyChecker } from '../../tools/ToolPolicyChecker';

export const workerSkillLoader = new SkillLoader();

export type RuntimeDeps = {
  agentEngine: AgentEngine;
  orchestrator: Pick<OrchestratorAdapter, 'processMessage'>;
};

export interface SpawnWorkerInput {
  parentSessionId: string;
  workerType: WorkerType;
  task: string;
  reason: string;
  expectedArtifactType?: string;
  executionMode?: WorkerRunMode;
  dependencyMode?: WorkerDependencyMode;
  continuationMode?: WorkerContinuationMode;
  planStepId?: string;
  mission?: MissionEnvelope;
  writeScope?: string[];
  budget?: WorkerTaskBudget;
}

export interface ContinueWorkerInput {
  parentSessionId: string;
  taskId: string;
  instruction?: string;
  budget?: ToolBudgetSnapshot;
}

export interface StopWorkerInput {
  parentSessionId: string;
  taskId: string;
  reason?: string;
}

export interface WaitForWorkerInput {
  parentSessionId: string;
  taskId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WorkerTaskOperationResult {
  task: WorkerTaskRecord;
  artifact?: WorkerResultArtifact;
  sessionId: string;
}

export const WORKER_TOOL_SELF_DENY = ['spawn_worker', 'continue_worker', 'stop_worker', 'wait_for_worker', 'submit_plan'];
export const WORKER_PARENT_BLOCK_REASONS = new Set([
  ...WORKER_INHERITED_BLOCK_REASONS,
  'worker_cancelled',
]);
export const TERMINAL_WORKER_TASK_STATUSES = new Set<WorkerTaskRecord['status']>([
  'completed',
  'failed',
  'cancelled',
]);
export const LIVE_WORKER_TASK_STATUSES = new Set<WorkerTaskRecord['status']>([
  'pending',
  'running',
  'blocked',
  'awaiting_input',
  'awaiting_approval',
]);
export const PARENT_CONTINUATION_TASK_STATUSES = new Set<WorkerTaskRecord['status']>([
  'completed',
  'failed',
  'cancelled',
  'awaiting_approval',
  'awaiting_input',
]);
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 120_000;
export const WAIT_POLL_INTERVAL_MS = 500;
export const WORKSPACE_PREFIX = '/workspace/';
export const WORKER_PARENT_POLICY_REASON = 'Tool is withheld because the parent session policy does not allow it.';

export const unique = (values: string[]): string[] => Array.from(new Set(values.filter((value) => value.trim().length > 0)));

export const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

export const uniqueSkillSlugs = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSkillSlug(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const cloneFlags = (flags: SessionFlags | undefined): SessionFlags => {
  if (!flags) {
    return {};
  }
  return JSON.parse(JSON.stringify(flags)) as SessionFlags;
};

export const cloneArtifact = (artifact: WorkerResultArtifact): WorkerResultArtifact =>
  JSON.parse(JSON.stringify(artifact)) as WorkerResultArtifact;

export const cloneTask = (task: WorkerTaskRecord): WorkerTaskRecord =>
  JSON.parse(JSON.stringify(task)) as WorkerTaskRecord;

export const normalizeWaveIndex = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
};

export const chooseNarrowerNetwork = (
  parentMode: ToolAccessPolicy['network'],
  templateMode?: ToolAccessPolicy['network'],
): ToolAccessPolicy['network'] => {
  const order: Record<NonNullable<ToolAccessPolicy['network']>, number> = {
    none: 0,
    allowlist: 1,
    bridge: 2,
  };

  if (!parentMode) {
    return templateMode;
  }
  if (!templateMode) {
    return parentMode;
  }
  return order[parentMode] <= order[templateMode] ? parentMode : templateMode;
};

export const filterPatternsForTools = (patterns: string[] | undefined, tools: string[], checker: ToolPolicyChecker): string[] | undefined => {
  if (!Array.isArray(patterns) || patterns.length === 0 || tools.length === 0) {
    return undefined;
  }
  const matched = patterns.filter((pattern) => tools.some((tool) => checker.isToolAllowedByPolicy({ ask: [pattern] }, tool)));
  return matched.length > 0 ? unique(matched) : undefined;
};

export const intersectHosts = (parentHosts: string[] | undefined, templateHosts: string[] | undefined): string[] | undefined => {
  if (!Array.isArray(parentHosts) || parentHosts.length === 0) {
    return Array.isArray(templateHosts) && templateHosts.length > 0 ? unique(templateHosts) : undefined;
  }
  if (!Array.isArray(templateHosts) || templateHosts.length === 0) {
    return unique(parentHosts);
  }
  const parentSet = new Set(parentHosts.map((value) => value.toLowerCase()));
  const matched = templateHosts.filter((value) => parentSet.has(value.toLowerCase()));
  return matched.length > 0 ? unique(matched) : undefined;
};

export const now = (): number => Date.now();

export const compactText = (value: string, maxLength = 240): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
};

export const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw new Error('wait_aborted');
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('wait_aborted'));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export const formatBlockedReason = (blockedReason: string): string =>
  blockedReason.replace(/_/gu, ' ');

export const CONFIRMED_VALIDATION_PREFIX = /^\[CONFIRMED\](?:\s|$)/i;
export const MISSING_FINDING_SUBMISSION_WARNING =
  'Worker completed with a [CONFIRMED] validation artifact, but no report_finding call was recorded.';

export const taskHasExecutableTool = (task: WorkerTaskRecord, toolName: string): boolean =>
  Array.isArray(task.toolPreflight?.executableTools) && task.toolPreflight.executableTools.includes(toolName);

export const isConfirmedValidationArtifact = (
  task: Pick<WorkerTaskRecord, 'workerType'>,
  artifact: Pick<WorkerResultArtifact, 'summary'> | undefined,
): boolean =>
  task.workerType === 'validator_worker' &&
  typeof artifact?.summary === 'string' &&
  CONFIRMED_VALIDATION_PREFIX.test(artifact.summary.trim());

export const getReportedFindingIds = (session: Pick<SessionState, 'flags'>): string[] => {
  const securityOps = session.flags?.securityops;
  if (!securityOps || typeof securityOps !== 'object' || Array.isArray(securityOps)) {
    return [];
  }

  const candidate = (securityOps as Record<string, unknown>).reportedFindingIds;
  return Array.isArray(candidate)
    ? candidate.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
};

export const buildWorkerToolContractLines = (task: WorkerTaskRecord): string[] => {
  const availableTools = Array.isArray(task.toolPreflight?.advertisedTools)
    ? task.toolPreflight.advertisedTools
    : [];
  const withheldTools = Array.isArray(task.toolPreflight?.withheldTools)
    ? task.toolPreflight.withheldTools
    : [];

  return [
    availableTools.length > 0 ? `Available tools in this worker session: ${availableTools.join(', ')}` : null,
    withheldTools.length > 0
      ? `Withheld tools in this worker session: ${withheldTools.map((entry) => `${entry.tool} (${entry.reason})`).join('; ')}`
      : null,
    withheldTools.length > 0
      ? 'Do not call withheld tools. If shell_run is withheld, stay inside the available HTTP/browser/file tools and return a structured artifact instead of improvising unavailable scanner commands.'
      : null,
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);
};

export const buildMissionEnvelopePromptLines = (task: Pick<WorkerTaskRecord, 'mission'>): string[] =>
  task.mission ? ['Mission envelope:', ...renderMissionEnvelope(task.mission).map((line) => `- ${line}`)] : [];

export const getSecurityOpsFlags = (flags: SessionFlags | undefined): Record<string, unknown> => {
  const candidate = flags?.securityops;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
};

export const getActivePhaseKey = (flags: SessionFlags | undefined): RunPhaseKey | null =>
  normalizePhaseKey(getSecurityOpsFlags(flags).activePhaseKey);

export const getPhaseAssignedSkillSlugs = (flags: SessionFlags | undefined): string[] => {
  const candidate = getSecurityOpsFlags(flags).phaseAssignedSkillSlugs;
  return Array.isArray(candidate)
    ? uniqueSkillSlugs(candidate.filter((value): value is string => typeof value === 'string'))
    : [];
};

export const extractContextSection = (context: string, header: string): string | null => {
  const start = context.indexOf(header);
  if (start < 0) {
    return null;
  }

  const afterHeader = context.slice(start + header.length);
  const nextHeaderMatch = afterHeader.match(/\r?\n(?:=== [^\r\n]+ ===|#\s+)/);
  const end = nextHeaderMatch?.index !== undefined
    ? start + header.length + nextHeaderMatch.index
    : context.length;
  const section = context.slice(start, end).trim();
  return section.length > 0 ? section : null;
};

export const buildPhaseWorkerContext = (
  parentSession: SessionState,
  activePhaseKey: RunPhaseKey,
): string => {
  const parentContext = typeof parentSession.extraContext === 'string' ? parentSession.extraContext : '';
  const authoritySections = [
    '=== TARGET CONTEXT ===',
    '=== CODE REVIEW RUN CONTEXT ===',
    '=== HOST BOUNDARY ===',
    '=== ORGANIZATION CONTEXT ===',
    '=== ORGANIZATION BRIEF ===',
    '=== SCOPE CONTEXT ===',
    '=== AUTHORITY BOUNDARY ===',
    '=== AUTHORIZED TARGETS ===',
    '=== ENGAGEMENT BRIEF ===',
    '=== EXECUTION ENVIRONMENT ===',
    '=== PRIVATE RUNNER NETWORK PREFLIGHT ===',
    '=== SCOPE OPERATOR NOTES ===',
    '=== CONNECTED REPOSITORIES ===',
    '=== SCOPE ACCESS MATERIAL ===',
  ]
    .map((header) => extractContextSection(parentContext, header))
    .filter((section): section is string => Boolean(section));
  const relevantStateSections = [
    '=== PRIOR PHASE HANDOFF ===',
    '=== LATEST PHASE CHECKPOINT ===',
  ]
    .map((header) => extractContextSection(parentContext, header))
    .filter((section): section is string => Boolean(section));

  const phaseFlags = getSecurityOpsFlags(parentSession.flags);
  const activePhaseId = typeof phaseFlags.activePhaseId === 'string' ? phaseFlags.activePhaseId : undefined;

  return [
    ...authoritySections,
    '=== ACTIVE RUN PHASE ===',
    `phase: ${activePhaseKey}`,
    activePhaseId ? `phaseId: ${activePhaseId}` : '',
    '',
    '=== WORKER PHASE SCOPE ===',
    'The parent plan, unrelated missions, unverified observations, and phase-wide skill catalog are intentionally omitted. Work only from WORKER MISSION, the authority above, bounded handoff/checkpoint state, canonical query tools, and mission-linked artifacts.',
    ...relevantStateSections,
  ].filter((line) => line.trim().length > 0).join('\n');
};

export const buildPhaseScopedParentContext = (
  parentSession: SessionState,
): string => {
  const parentContext = typeof parentSession.extraContext === 'string' && parentSession.extraContext.trim().length > 0
    ? parentSession.extraContext.trim()
    : '';
  const activePhaseKey = getActivePhaseKey(parentSession.flags);
  if (!activePhaseKey) {
    return parentContext || 'No additional parent context provided.';
  }

  return buildPhaseWorkerContext(parentSession, activePhaseKey);
};

export const buildWorkerKickoffPrompt = (task: WorkerTaskRecord, template: WorkerTemplate): string => {
  const dependencyMode = task.dependencyMode ?? template.preferredDependencyMode;
  const validatorCanReportFinding =
    template.workerType === 'validator_worker' && taskHasExecutableTool(task, 'report_finding');
  const missionPhase = typeof task.mission?.phase === 'string' && task.mission.phase.trim().length > 0
    ? task.mission.phase.trim().toLowerCase()
    : null;
  const lines = [
    `You are acting as a bounded ${template.label.toLowerCase()} for a parent executor.`,
    missionPhase
      ? `You are running INSIDE the parent's active phase: ${missionPhase}. Your tool policy, allowed skills, and write scope are all phase-scoped — work only on what this phase exists to produce. Do not call tools outside the phase profile, do not author cross-phase artifacts, and do not call submit_phase_handoff (the parent owns phase exit).`
      : null,
    `Task ID: ${task.taskId}`,
    `Reason for delegation: ${task.reason}`,
    `Expected artifact: ${task.expectedArtifactType}`,
    `Execution mode: ${task.executionMode}`,
    `Dependency mode: ${dependencyMode}`,
    typeof task.budget?.maxToolCalls === 'number' ? `Max tool calls this turn: ${task.budget.maxToolCalls}` : 'Max tool calls this turn: inherited from session',
    task.writeScope && task.writeScope.length > 0 ? `Allowed write scope: ${task.writeScope.join(', ')}` : 'Allowed write scope: none',
    task.mission ? 'Use the exact WORKER MISSION in TARGET CONTEXT; do not widen or reinterpret it.' : null,
    ...buildWorkerToolContractLines(task),
    '',
    'Task:',
    task.task,
    '',
    'Your parent cannot see your hidden reasoning or raw tool traces unless you return them in the artifact.',
    'Your mission envelope is the complete working context. Read only projection detail files named by the mission, evidence refs, or current blocker.',
    'Projection files under context/, recon/, journal/model.*, journal/leads.*, journal/coverage.*, findings/, scans/digest.*, and skills/index.* are read-only. Use canonical tools for canonical writes.',
    task.mission?.assignedSkills && task.mission.assignedSkills.length > 0
      ? `Assigned methodology: ${task.mission.assignedSkills.map((skill) => `/workspace/.skills/${skill}/methodology.md`).join(', ')}`
      : 'Use only the assigned methodology already synced under /workspace/.skills/ for this worker.',
    template.workerType === 'enumeration_worker'
      ? `All agents in this run share /workspace. Put every local artifact under /workspace/.artifacts/workers/enumeration/${task.taskId}/ and use /workspace/... paths in evidenceRefs.`
      : template.workerType === 'attack_worker'
        ? `Put every proof script, impact artifact, restricted extraction, attack result, and cleanup artifact under /workspace/.artifacts/workers/attack/${task.taskId}/. Never write elsewhere.`
      : 'All agents in this run share /workspace. Put scanner output under /workspace/.artifacts/scans/<task-or-tool>/ and use /workspace/... paths in evidenceRefs.',
    task.writeScope && task.writeScope.length > 0
      ? 'If you create PoC scripts or local evidence, keep every write inside the allowed write scope only.'
      : 'If you need to save a PoC script or local evidence file, stop and return a structured artifact instead of writing outside your current scope.',
    task.writeScope && task.writeScope.length > 0 && taskHasExecutableTool(task, 'ingest_scan_artifact')
      ? 'When calling ingest_scan_artifact, always pass the exact artifactPath inside the allowed write scope. Scoped workers may not use artifact auto-discovery.'
      : null,
    dependencyMode === 'dependency'
      ? 'Your parent may be waiting on this result. If you have enough evidence to guide the next step, submit_worker_result immediately instead of widening scope.'
      : 'You are a sidecar branch. Stay bounded and return early once the current slice is informative enough for the parent to synthesize.',
    validatorCanReportFinding
      ? 'If you independently CONFIRM a real issue with durable evidence, call report_finding before submit_worker_result. Include the returned finding ID in findings[].'
      : null,
    template.workerType === 'recon_worker'
      ? 'For reconnaissance, stop after the current useful mapping pass. Do not keep crawling marginal paths once the primary surface, tech stack, and highest-value entrypoints are mapped.'
      : template.workerType === 'enumeration_worker'
        ? 'For every target action, preserve the server-issued enumerationAttemptReceipt and use its fingerprint for the matching mission technique in enumeration.attempts. Return leads, negatives, blockers, coverage, and artifacts only; findings must remain empty.'
      : template.workerType === 'attack_worker'
        ? 'Execute only the admitted attack objective. Collect the minimum proof required, perform and prove cleanup whenever state changed, and stop. Findings must remain empty.'
      : 'If the current bounded objective is complete or decisively blocked, submit_worker_result now rather than starting a new branch of work.',
    template.workerType === 'enumeration_worker'
      ? 'Enumeration lead semantics: evidenceState="durable" means the lead observation and hypothesis are backed by durable evidenceRefs; it does NOT mean the vulnerability is validated. A validation-ready lead has durable evidenceRefs. Do not put next-phase validation actions such as safe HTTP replay, bounded GET/POST probing, or payload variation into prerequisites; reserve prerequisites for missing external access, credentials, OOB infrastructure, or scope approval.'
      : null,
    template.workerType === 'enumeration_worker'
      ? 'Use exact enumeration_result/v1 lead field names: localId, riskFamily, techniqueId, targetRef, surfaceRef, hypothesis, observation, validationGoal, requiredControls, prerequisites, evidenceRefs, evidenceState, confidence, priority, authContextClass. Do not invent surfaces or plugins; every durable observation must be supported by evidenceRefs.'
      : null,
    template.workerType === 'enumeration_worker'
      ? 'Before you stop, call submit_worker_result exactly once with expectedArtifactType="enumeration_result/v1", generic findings=[], and the complete typed enumeration result.'
      : template.workerType === 'attack_worker'
        ? `Before you stop, call submit_worker_result exactly once with generic findings=[], attack_result/v1, and missionId="${task.taskId}". Separate impact proof from cleanup proof and state remaining risk when cleanup failed or is unknown.`
      : 'Before you stop, call submit_worker_result exactly once with a structured artifact containing the concrete findings, evidence refs, touched targets, and the best next action.',
  ];
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
};

export const buildParentContinuationPrompt = (
  task: WorkerTaskRecord,
  sharedStateSync: SharedStateSyncResult = EMPTY_SHARED_STATE_SYNC,
): string => {
  const dependencyMode = task.dependencyMode ?? 'sidecar';
  const artifact = task.artifact;
  const parentReadableEvidenceRefs = artifact?.parentReadableEvidenceRefs ?? artifact?.evidenceRefs ?? [];
  const mergedDiscoveries = [...sharedStateSync.addedDescriptions, ...sharedStateSync.updatedDescriptions];
  const lines = [
    'A background worker task changed state.',
    `Task ID: ${task.taskId}`,
    `Worker type: ${task.workerType}`,
    `Status: ${task.status}`,
    `Dependency mode: ${dependencyMode}`,
    `Delegation reason: ${task.reason}`,
    task.mission ? `Mission question: ${task.mission.question}` : null,
    task.mission ? `Mission stop condition: ${task.mission.stopCondition}` : null,
    typeof task.summary === 'string' && task.summary.trim().length > 0
      ? `Latest summary: ${task.summary.trim()}`
      : typeof task.lastStatusReason === 'string' && task.lastStatusReason.trim().length > 0
        ? `Latest status detail: ${task.lastStatusReason.trim()}`
        : 'Latest status detail: none',
    parentReadableEvidenceRefs.length > 0
      ? `Parent-readable evidence refs: ${parentReadableEvidenceRefs.join(', ')}`
      : null,
    mergedDiscoveries.length > 0
      ? `Shared-state discoveries merged: ${mergedDiscoveries.join('; ')}`
      : null,
    '',
    'Review the WORKER TASKS section, synthesize any completed artifact yourself, and decide the next best action.',
    'The worker wrote into the shared run workspace. Read the evidence refs directly; do not look for a copied handoff directory.',
    mergedDiscoveries.length > 0
      ? 'The worker discoveries above are already merged into SESSION MEMORY. Use that shared state instead of reconstructing child-local context.'
      : null,
    'Update your internal coverage map: what is now confirmed, refuted, newly reachable, or still uncovered?',
    dependencyMode === 'dependency'
      ? 'This worker was marked as a dependency. Avoid overlapping the same coverage path; either wait_for_worker, continue_worker with a tighter instruction, or synthesize the returned artifact before moving on.'
      : 'This worker was marked as a sidecar. Sidecars are event-driven: do not call wait_for_worker on them. Continue locally only on non-overlapping work and react from real artifacts.',
    'Do not rerun the same broad recon or validation path unless you can name the specific gap the worker artifact did not cover.',
    'If the same worker context is still useful, use continue_worker with a specific follow-up instruction.',
    'If the next task needs fresh context or a different specialty, spawn_worker instead.',
    'Prefer local synthesis unless a bounded specialist would materially improve coverage or confidence.',
    'If the overall run is now complete, finish the parent outputs rather than launching unnecessary new work.',
  ];
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
};

export const buildWorkerContinuationPrompt = (
  task: WorkerTaskRecord,
  boundedInstruction?: string,
): string => {
  const dependencyMode = task.dependencyMode ?? 'sidecar';
  const validatorCanReportFinding =
    task.workerType === 'validator_worker' && taskHasExecutableTool(task, 'report_finding');
  const enumerationAttempts = task.workerType === 'enumeration_worker'
    ? (task.enumerationAttempts ?? [])
    : [];
  const enumerationAttemptReceipts = enumerationAttempts.map((attempt) => {
    const techniqueFingerprints = Object.entries(attempt.fingerprintsByTechnique)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([techniqueId, fingerprint]) => `${techniqueId}:${fingerprint}`)
      .join(',');
    return [
      attempt.reservationFingerprint,
      attempt.status,
      attempt.surfaceRef,
      attempt.toolClass,
      attempt.actionClass,
      attempt.personaClass,
      `requests=${attempt.requestCount}`,
      `techniques=${techniqueFingerprints || 'none'}`,
    ].join(' | ');
  });
  const remainingTargetRequests =
    (task.workerType === 'enumeration_worker' || task.workerType === 'attack_worker') &&
    typeof task.budget?.maxTargetRequests === 'number'
      ? Math.max(0, task.budget.maxTargetRequests - (task.targetRequestsUsed ?? 0))
      : undefined;
  const remainingWallMs =
    (task.workerType === 'enumeration_worker' || task.workerType === 'attack_worker') && typeof task.deadlineAt === 'number'
      ? Math.max(0, task.deadlineAt - Date.now())
      : undefined;
  return [
    'continue',
    `Remain bounded. Dependency mode: ${dependencyMode}.`,
    boundedInstruction?.trim()
      ? `Parent bounded continuation input: ${boundedInstruction.trim()}`
      : '',
    task.mission ? `Mission question: ${task.mission.question}` : '',
    task.mission ? `Stop condition: ${task.mission.stopCondition}` : '',
    remainingTargetRequests !== undefined
      ? `Remaining target-request budget: ${remainingTargetRequests}.`
      : '',
    remainingWallMs !== undefined
      ? `Original mission deadline remains in force; approximately ${remainingWallMs} ms remain.`
      : '',
    enumerationAttemptReceipts.length > 0
      ? ['Prior server-issued attempt receipts:', ...enumerationAttemptReceipts.map((receipt) => `- ${receipt}`)].join('\n')
      : task.workerType === 'enumeration_worker'
        ? 'Prior server-issued attempt receipts: none.'
        : '',
    task.workerType === 'recon_worker'
      ? 'If the primary surface is mapped well enough to guide the parent, call submit_worker_result now. Do not continue broad crawling for marginal endpoints.'
      : task.workerType === 'enumeration_worker'
        ? 'Use the prior server-issued attempt receipts; do not repeat a reserved target action. If the lead observation has durable evidenceRefs, mark evidenceState="durable" even though validation still needs to prove exploitability. Do not list validation-phase HTTP replay or safe GET/POST probing as prerequisites. Submit a typed enumeration_result/v1 with generic findings empty once the narrowed objective is complete or blocked.'
      : task.workerType === 'attack_worker'
        ? 'Do not widen the admitted objective or target. If impact is proven, complete cleanup and submit attack_result/v1 now; if denied or inconclusive, record the exact limitation and stop.'
      : validatorCanReportFinding
        ? 'If the current hypothesis is already CONFIRMED with durable proof, call report_finding before submit_worker_result. If it is refuted or clearly blocked, submit_worker_result now.'
        : 'If the current hypothesis is already confirmed, refuted, or clearly blocked, call submit_worker_result now.',
    'Do not start unrelated exploration.',
  ].join('\n');
};

export const buildWorkerExtraContext = (
  parentSession: SessionState,
  task: WorkerTaskRecord,
  template: WorkerTemplate,
): string => {
  const inheritedContext = buildPhaseScopedParentContext(parentSession);

  return [
    `Parent session: ${parentSession.id}`,
    `Worker role: ${template.label}`,
    `Expected artifact type: ${task.expectedArtifactType}`,
    task.mission ? ['=== WORKER MISSION ===', ...renderMissionEnvelope(task.mission)].join('\n') : '',
    inheritedContext,
  ].filter((line) => line.length > 0).join('\n');
};

export const buildWorkerToolPreflight = (
  advertisedTools: string[],
  executableTools: string[],
  withheldTools: WorkerToolPreflightEntry[],
): WorkerToolPreflight => ({
  advertisedTools: unique(advertisedTools),
  executableTools: unique(executableTools),
  ...(withheldTools.length > 0 ? { withheldTools } : {}),
});

export const buildFallbackArtifact = (session: SessionState, task: WorkerTaskRecord): WorkerResultArtifact => {
  const latestAssistant = [...session.messages]
    .reverse()
    .find((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0);
  const latestTool = [...session.messages]
    .reverse()
    .find((message) => message.role === 'tool' && typeof message.content === 'string' && message.content.trim().length > 0);
  const summary =
    latestAssistant?.content.trim() ||
    latestTool?.content.trim() ||
    `Worker ${task.workerType} ended without submitting a structured artifact.`;

  return {
    taskId: task.taskId,
    workerType: task.workerType,
    summary,
    findings: [],
    evidenceRefs: [],
    touchedTargets: [],
    recommendedNextAction: 'Review the worker session and decide whether to retry with a narrower task.',
    confidence: 0.25,
  };
};

export const asWorkspaceRelativePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith(WORKSPACE_PREFIX)) {
    return null;
  }
  const relative = trimmed.slice(WORKSPACE_PREFIX.length);
  if (relative.length === 0) {
    return null;
  }
  const normalized = normalizePosixPath(relative);
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    return null;
  }
  return normalized;
};

export const cloneMemory = (memory: AgentMemory | undefined): AgentMemory =>
  JSON.parse(JSON.stringify(memory ?? MemoryManager.initialize())) as AgentMemory;

export const clampConfidence = (value: number | undefined, fallback = 0.8): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
};

export const isHttpUrl = (value: string): boolean => /^https?:\/\//iu.test(value);

export const looksLikeHost = (value: string): boolean =>
  /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/iu.test(value) ||
  /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value);

export type SharedStateCandidate = {
  category: FactCategory;
  key: string;
  value: unknown;
  description: string;
};

export type SharedStateSyncResult = {
  addedDescriptions: string[];
  updatedDescriptions: string[];
};

export const EMPTY_SHARED_STATE_SYNC: SharedStateSyncResult = {
  addedDescriptions: [],
  updatedDescriptions: [],
};

export const inferSharedStateCandidates = (artifact: WorkerResultArtifact): SharedStateCandidate[] => {
  const candidates = new Map<string, SharedStateCandidate>();
  const sourceEvidenceRefs =
    Array.isArray(artifact.sourceEvidenceRefs) && artifact.sourceEvidenceRefs.length > 0
      ? artifact.sourceEvidenceRefs
      : artifact.evidenceRefs;
  const rawValues = [...(artifact.touchedTargets ?? []), ...(sourceEvidenceRefs ?? [])];
  const addCandidate = (candidate: SharedStateCandidate): void => {
    if (!candidates.has(candidate.key)) {
      candidates.set(candidate.key, candidate);
    }
  };

  for (const rawValue of rawValues) {
    if (typeof rawValue !== 'string') {
      continue;
    }
    const value = rawValue.trim();
    if (!value) {
      continue;
    }

    if (isHttpUrl(value)) {
      try {
        const parsed = new URL(value);
        const normalized = parsed.toString();
        addCandidate({
          category: 'endpoint',
          key: `endpoint:url:${normalized.toLowerCase()}`,
          value: {
            url: normalized,
            host: parsed.host,
            path: parsed.pathname || '/',
          },
          description: `endpoint ${normalized}`,
        });
        continue;
      } catch {
        // Fall through and treat it as a plain string if URL parsing fails.
      }
    }

    if (value.startsWith('/')) {
      addCandidate({
        category: 'endpoint',
        key: `endpoint:path:${value}`,
        value: {
          path: value,
        },
        description: `endpoint ${value}`,
      });
      continue;
    }

    if (looksLikeHost(value)) {
      addCandidate({
        category: 'configuration',
        key: `surface:host:${value.toLowerCase()}`,
        value: {
          host: value,
        },
        description: `host ${value}`,
      });
    }
  }

  return Array.from(candidates.values());
};

