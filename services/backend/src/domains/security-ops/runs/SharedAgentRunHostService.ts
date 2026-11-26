import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import type { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import type {
  SessionState,
  StreamEvent,
  ToolAccessPolicy,
} from '@/domains/agent-brain/domain/types';
import type { PromptProfile } from '@/domains/agent-brain/domain/prompts';
import type { RuntimeHostCapabilities } from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import {
  attachMissionPhases,
  phaseProfileRegistry,
  type RunPhaseKey,
} from './PhaseProfileRegistry';
import {
  EXECUTION_PHASE_KICKOFF_PROMPTS,
  PLANNER_KICKOFF_PROMPT,
  REPORTING_PHASE_KICKOFF_PROMPT,
  VALIDATION_PHASE_KICKOFF_PROMPT,
  buildPhasePlanSeed,
  type FreshExecutionPhaseKey,
} from './StartRunPromptHelpers';
import {
  registerHostedRunPersistencePort,
  type HostedRunPersistencePort,
  type HostedRunPhase,
} from './HostedRunPersistencePort';
import type { CodeReviewContext } from '@/db/schema';
import type { CodeReviewManifestFile } from './codeReviewRunContext';
import {
  buildHostedCodeReviewContext,
  fetchHostedRepositoryManifest,
  hostedReviewWritesDurableMemory,
} from './hostedCodeReviewContext';
import {
  syncAssignedSkillsIntoWorkspace,
  syncPlanningSkillIntoWorkspace,
} from './skillWorkspaceSync';
import type {
  AgentRunEvent,
  AgentRunEventSink,
  AgentRunHandle,
  AgentRunHost,
  AgentRunHostContext,
} from '@/app/public/agentRunHost';

type SharedAgentRunRuntime = {
  sessionStore: SessionStore;
  sandbox: SandboxAdapter;
  streamBroker: StreamBroker;
  orchestrator: OrchestratorAdapter;
  runtimeHostCapabilities: RuntimeHostCapabilities;
};

export type SharedAgentRunExecutionResult = {
  runId: string;
  status: 'completed' | 'paused' | 'failed' | 'cancelled';
  phaseCount: number;
  findingCount: number;
  summary: string;
};

const HOSTED_PHASE_TOOLS = new Set([
  'file_read',
  'file_write',
  'shell_run',
  'wait_for_shell_job',
  'python_session',
  'list_relevant_skills',
  'load_skill',
  'query_inventory',
  'query_findings',
  'query_notes',
  'submit_plan',
  'list_connected_repositories',
  'search_connected_repository',
  'read_connected_repository_file',
  'report_finding',
  'spawn_worker',
  'continue_worker',
  'stop_worker',
  'wait_for_worker',
  'submit_worker_result',
  'submit_phase_handoff',
  'submit_phase_checkpoint',
  // Code Review profile. These resolve through the hosted persistence port and
  // never reach a GitHub credential or the organization database.
  'list_code_review_repository_files',
  'search_code_review_repository',
  'query_code_review_findings',
  'report_code_review_candidate',
  'validate_code_review_finding',
  'finalize_code_review_report',
  'query_code_review_memory',
  'record_code_review_memory',
]);
const HOSTED_WORKER_TOOLS = new Set([
  'spawn_worker',
  'continue_worker',
  'stop_worker',
  'wait_for_worker',
  'submit_worker_result',
]);

const SKIPPED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.research-venv',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

export const buildHostedAssignedMethodContext = (skillSlugs: readonly string[]): string => {
  const normalized = Array.from(new Set(
    skillSlugs.map((slug) => slug.trim().toLowerCase()).filter(Boolean),
  ));
  if (normalized.length === 0) return '';
  return [
    '=== ASSIGNED METHODOLOGIES ===',
    ...normalized.map((slug) => `- ${slug}: /workspace/.skills/${slug}/methodology.md`),
  ].join('\n');
};

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const settleWithin = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutReason: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutReason)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

type HostedBudgetUsage = {
  modelRequests: number;
  recordedCost: number;
};

type HostedUsageMeta = {
  phaseKey: RunPhaseKey;
  sessionId: string;
};

const HOSTED_PHASE_CLOSEOUT_RATIO: Record<RunPhaseKey, number> = {
  planning: 0.25,
  recon: 0.45,
  enumeration: 0.60,
  validation: 0.80,
  exploitation: 0.80,
  control_assessment: 0.80,
  evidence: 0.88,
  reporting: 0.95,
  review_mapping: 0.45,
  review_analysis: 0.7,
  review_validation: 0.85,
  review_reporting: 0.95,
};

export const resolveHostedUsdGuardrail = (maxUsd: number | undefined): {
  userLimit?: number;
  safetyReserve: number;
  stopAt?: number;
} => {
  if (maxUsd === undefined) return { safetyReserve: 0 };
  const safetyReserve = Math.min(0.1, Math.max(0.05, maxUsd * 0.2));
  return {
    userLimit: maxUsd,
    safetyReserve,
    stopAt: Math.max(0, maxUsd - safetyReserve),
  };
};

export const evaluateHostedBudget = (
  phaseKey: RunPhaseKey,
  budget: AgentRunHostContext['budget'],
  usage: HostedBudgetUsage,
): {
  closeout: boolean;
  stopReason?: 'max_model_requests_exceeded' | 'max_usd_safety_reserve_reached';
  usdGuardrail: ReturnType<typeof resolveHostedUsdGuardrail>;
} => {
  const usdGuardrail = resolveHostedUsdGuardrail(budget.maxUsd);
  const closeoutRatio = HOSTED_PHASE_CLOSEOUT_RATIO[phaseKey];
  const requestCloseoutAt = budget.maxModelRequests === undefined
    ? undefined
    : Math.max(1, Math.floor(budget.maxModelRequests * closeoutRatio));
  const usdCloseoutAt = usdGuardrail.stopAt === undefined
    ? undefined
    : usdGuardrail.stopAt * closeoutRatio;
  const closeout = (
    (requestCloseoutAt !== undefined && usage.modelRequests >= requestCloseoutAt)
    || (usdCloseoutAt !== undefined && usage.recordedCost >= usdCloseoutAt)
  );

  if (
    budget.maxModelRequests !== undefined
    && usage.modelRequests >= budget.maxModelRequests
  ) {
    return { closeout, stopReason: 'max_model_requests_exceeded', usdGuardrail };
  }
  if (
    usdGuardrail.stopAt !== undefined
    && usage.recordedCost >= usdGuardrail.stopAt
  ) {
    return { closeout, stopReason: 'max_usd_safety_reserve_reached', usdGuardrail };
  }
  return { closeout, usdGuardrail };
};

const closeoutInstruction = (phaseKey: RunPhaseKey): string => {
  const terminalTool = phaseKey === 'planning' ? 'submit_plan' : 'submit_phase_handoff';
  return [
    'HOSTED RUN BUDGET CLOSEOUT',
    'The phase has reached its allocated share of the run budget.',
    'Stop broad exploration and do not start new workers or scans.',
    `Preserve the strongest current evidence and call ${terminalTool} now.`,
    'A partial, explicit handoff is preferable to losing downstream validation and reporting.',
  ].join('\n');
};

const compact = (value: unknown, maxLength = 4000): unknown => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text || text.length <= maxLength) return value;
  return `${text.slice(0, maxLength)}…`;
};

const CODE_REVIEW_PHASE_ORDER: RunPhaseKey[] = [
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
];

const CODE_REVIEW_PHASE_SKILL: Record<string, string> = {
  review_mapping: 'code-review-mapping',
  review_analysis: 'code-review-analysis',
  review_validation: 'code-review-validation',
  review_reporting: 'code-review-reporting',
};

const isCodeReviewPhase = (phaseKey: RunPhaseKey): boolean =>
  CODE_REVIEW_PHASE_ORDER.includes(phaseKey);

const executionModeForPhase = (
  phaseKey: RunPhaseKey,
): NonNullable<SessionState['executionMode']> => {
  if (phaseKey === 'recon' || phaseKey === 'enumeration') return 'discovery';
  if (phaseKey === 'evidence' || phaseKey === 'reporting') return 'evidence';
  if (phaseKey === 'review_mapping') return 'discovery';
  if (phaseKey === 'review_reporting') return 'evidence';
  return 'validation';
};

const CODE_REVIEW_PHASE_KICKOFF: Record<string, string> = {
  review_mapping:
    'Start review_mapping. Build a bounded architecture, entrypoint, trust-boundary, authorization, data-flow, dependency, and test map for the exact immutable commit, then hand off.',
  review_analysis:
    'Start review_analysis. Perform source-first analysis over the mapped surface and persist attributable candidates with exact code locations, then hand off.',
  review_validation:
    'Start review_validation. Independently falsify every current-run candidate, record a validated or rejected disposition with rationale and agent-owned fixability, then hand off.',
  review_reporting:
    'Start review_reporting. Reconcile canonical outcomes and coverage, finalize the standalone Code Review report with an honest completeness decision, then hand off.',
};

const kickoffForPhase = (phaseKey: RunPhaseKey): string => {
  if (isCodeReviewPhase(phaseKey)) {
    return CODE_REVIEW_PHASE_KICKOFF[phaseKey]
      ?? `Start the ${phaseKey} phase and complete its missions.`;
  }
  if (phaseKey === 'validation') return VALIDATION_PHASE_KICKOFF_PROMPT;
  if (phaseKey === 'reporting') return REPORTING_PHASE_KICKOFF_PROMPT;
  return EXECUTION_PHASE_KICKOFF_PROMPTS[phaseKey as FreshExecutionPhaseKey]
    ?? `Start the ${phaseKey} phase and complete its missions.`;
};

const filterHostedToolPolicy = (
  policy: ToolAccessPolicy,
  phaseKey: RunPhaseKey,
  options: { memoryWritable?: boolean } = {},
): ToolAccessPolicy => ({
  ...policy,
  allow: (policy.allow ?? []).filter((tool) =>
    HOSTED_PHASE_TOOLS.has(tool)
    && (phaseKey === 'validation' || !HOSTED_WORKER_TOOLS.has(tool))
    // Matches the product rule: a run that cannot write durable memory never
    // sees the writer, rather than discovering the rejection mid-phase.
    && (tool !== 'record_code_review_memory' || options.memoryWritable === true)),
  deny: [
    ...(policy.deny ?? []),
    'report_asset',
    'report_service',
    'report_note',
    'promote_finding',
    'submit_validation_outcome',
    'submit_validation_lead_outcome',
    'finalize_run_artifacts',
    'prepare_report_context',
    'report_finalizer_preflight',
  ],
  network: 'none',
});

const isCancellation = (signal: AbortSignal): boolean =>
  signal.aborted && String(signal.reason ?? '').includes('cancel');

const isPause = (signal: AbortSignal): boolean => {
  if (!signal.aborted) return false;
  const reason = String(signal.reason ?? '');
  return reason.includes('paused')
    || reason.endsWith('_exceeded')
    || reason === 'max_usd_safety_reserve_reached';
};

export class SharedAgentRunHostService implements AgentRunHost {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<SharedAgentRunExecutionResult>>();
  private readonly activeSessionIds = new Map<string, Set<string>>();
  private codeReviewContext: CodeReviewContext | null = null;
  private codeReviewManifest: CodeReviewManifestFile[] = [];
  private codeReviewMemoryPrompt = '';

  constructor(
    private readonly runtime: SharedAgentRunRuntime,
    private readonly persistence: HostedRunPersistencePort,
  ) {}

  async start(
    context: AgentRunHostContext,
    events: AgentRunEventSink,
  ): Promise<AgentRunHandle> {
    if (this.executions.has(this.persistence.runId)) {
      throw new Error(`Hosted run is already active: ${this.persistence.runId}`);
    }
    const execution = this.execute(context, events);
    this.executions.set(this.persistence.runId, execution);
    const releaseExecution = (): void => {
      this.executions.delete(this.persistence.runId);
    };
    // Do not discard `execution.finally(...)`: the promise returned by finally rejects again when
    // execution rejects and can become a process-level unhandled rejection. Both handlers return
    // normally here, while the original execution promise remains authoritative for `wait()`.
    void execution.then(releaseExecution, releaseExecution);
    return {
      runId: this.persistence.runId,
      integration: 'shared_pipeline',
    };
  }

  async wait(runId = this.persistence.runId): Promise<SharedAgentRunExecutionResult> {
    const execution = this.executions.get(runId);
    if (!execution) throw new Error(`Hosted run is not active: ${runId}`);
    return execution;
  }

  async cancel(runId: string, reason = 'cancelled_by_operator'): Promise<void> {
    await this.stop(runId, reason);
  }

  async pause(runId: string, reason = 'paused_by_operator'): Promise<void> {
    await this.stop(runId, reason);
  }

  private async stop(runId: string, reason: string): Promise<void> {
    const controller = this.controllers.get(runId);
    if (!controller?.signal.aborted) {
      controller?.abort(reason);
    }
    const sessionIds = [...(this.activeSessionIds.get(runId) ?? [])];
    await settleWithin(Promise.allSettled(sessionIds.map(async (sessionId) => {
      await this.runtime.sessionStore.abortCurrentTurnAsync(sessionId, reason);
      const session = this.runtime.sessionStore.get(sessionId);
      if (session) await this.runtime.sandbox.stop(session, reason);
    })), 5_000, 'hosted_run_stop_cleanup_timeout').catch(() => undefined);
  }

  async recover(
    context: AgentRunHostContext,
    events: AgentRunEventSink,
  ): Promise<AgentRunHandle> {
    return this.start(context, events);
  }

  async execute(
    context: AgentRunHostContext,
    events: AgentRunEventSink,
  ): Promise<SharedAgentRunExecutionResult> {
    if (context.host !== 'research_lab') {
      throw new Error(`Shared hosted pipeline does not accept host ${context.host}`);
    }
    if (context.runProfile !== 'repository_research' && context.runProfile !== 'code_review') {
      throw new Error(`Unsupported hosted run profile: ${context.runProfile}`);
    }
    if (!context.repository) {
      throw new Error(`${context.runProfile} requires a pinned repository context`);
    }
    if (!context.modelName?.trim()) {
      throw new Error(`${context.runProfile} requires a resolved modelName`);
    }
    const hostedContext = context as AgentRunHostContext & {
      repository: NonNullable<AgentRunHostContext['repository']>;
    };

    // Code Review resolves its typed immutable identity before any session
    // exists, so an unusable manifest fails the run closed rather than
    // degrading into an unscoped review.
    if (context.runProfile === 'code_review') {
      const requiredPortMethods = [
        'reportCodeReviewCandidate',
        'validateCodeReviewFinding',
        'queryCodeReviewFindings',
        'finalizeCodeReviewReport',
      ] as const;
      const missing = requiredPortMethods.filter((method) => !this.persistence[method]);
      if (missing.length > 0) {
        throw new Error(
          `Hosted Code Review requires persistence support for: ${missing.join(', ')}`,
        );
      }
      const manifest = await fetchHostedRepositoryManifest(this.persistence);
      this.codeReviewContext = buildHostedCodeReviewContext({
        repository: hostedContext.repository,
        manifest,
      });
      this.codeReviewManifest = manifest.files;
    } else {
      this.codeReviewContext = null;
      this.codeReviewManifest = [];
    }

    const runId = this.persistence.runId;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    this.activeSessionIds.set(runId, new Set());
    const unregister = registerHostedRunPersistencePort(
      this.persistence,
      this.runtime.runtimeHostCapabilities,
    );
    const wallTimer = setTimeout(() => {
      controller.abort('max_wall_seconds_exceeded');
    }, context.budget.maxWallSeconds * 1000);
    const usage: HostedBudgetUsage = {
      modelRequests: 0,
      recordedCost: 0,
    };
    const usdGuardrail = resolveHostedUsdGuardrail(context.budget.maxUsd);
    const closeoutRequested = new Set<RunPhaseKey>();

    const emit = async (
      type: string,
      data: Record<string, unknown> = {},
      meta: Pick<AgentRunEvent, 'phaseKey' | 'sessionId' | 'workerTaskId'> = {},
    ): Promise<void> => {
      await events({
        type,
        at: new Date().toISOString(),
        runId,
        ...meta,
        data,
      });
    };

    const observeUsage = (event: StreamEvent, meta: HostedUsageMeta): void => {
      if (event.type !== 'usage.recorded') return;
      const data = asRecord(event.data);
      usage.modelRequests += 1;
      // Internal labs meter real provider cost; billed products meter the
      // customer-facing price. Defaulting to platform keeps product behaviour
      // unchanged for any host that does not declare a basis.
      usage.recordedCost += context.costBasis === 'native'
        ? numberValue(data.nativeCost ?? data.platformPrice)
        : numberValue(data.platformPrice ?? data.nativeCost);

      const decision = evaluateHostedBudget(meta.phaseKey, context.budget, usage);
      if (decision.closeout && !closeoutRequested.has(meta.phaseKey)) {
        closeoutRequested.add(meta.phaseKey);
        const liveSession = this.runtime.sessionStore.get(meta.sessionId);
        if (liveSession) {
          liveSession.flags = {
            ...(liveSession.flags ?? {}),
            ephemeralNudge: closeoutInstruction(meta.phaseKey),
          };
        }
        void emit('budget.closeout.requested', {
          message: `${meta.phaseKey} phase reached its budget share; requesting an immediate handoff`,
          modelRequests: usage.modelRequests,
          recordedCost: usage.recordedCost,
          maxModelRequests: context.budget.maxModelRequests,
          maxUsd: context.budget.maxUsd,
        }, meta);
      }

      if (decision.stopReason === 'max_usd_safety_reserve_reached' && !controller.signal.aborted) {
        void emit('budget.safety_stop', {
          message: 'Provider safety reserve reached before the user hard cap',
          recordedCost: usage.recordedCost,
          maxUsd: usdGuardrail.userLimit,
          safetyReserve: usdGuardrail.safetyReserve,
          stopAt: usdGuardrail.stopAt,
        }, meta);
        controller.abort(decision.stopReason);
      } else if (decision.stopReason && !controller.signal.aborted) {
        controller.abort(decision.stopReason);
      }
    };

    try {
      await emit('run.started', {
        message: 'Shared repository-research pipeline started',
        profile: context.runProfile,
        sourceMode: context.sourceMode,
        engineIntegration: 'shared_pipeline',
        runtimeHostCapabilities: this.runtime.runtimeHostCapabilities,
      });
      const plan = await this.ensurePlan(hostedContext, controller.signal, emit, observeUsage);
      if (controller.signal.aborted) throw new Error(String(controller.signal.reason));

      const missions = attachMissionPhases(plan.missions);
      if (this.codeReviewContext) {
        // Code Review cannot fall through to a Pentest or Compliance phase in a
        // hosted run any more than it can in the organization product.
        const foreign = missions.filter((mission) =>
          !mission.phase || !isCodeReviewPhase(mission.phase));
        if (foreign.length > 0) {
          throw new Error(
            `code_review planner selected non-Code-Review hosted phases: ${
              [...new Set(foreign.map((mission) => mission.phase ?? 'unset'))].join(', ')
            }`,
          );
        }
      } else {
        const unsupported = missions.filter((mission) =>
          mission.phase === 'exploitation'
          || mission.phase === 'control_assessment'
          || isCodeReviewPhase(mission.phase as RunPhaseKey));
        if (unsupported.length > 0) {
          throw new Error(
            `repository_research planner selected unsupported hosted phases: ${
              [...new Set(unsupported.map((mission) => mission.phase))].join(', ')
            }`,
          );
        }
      }
      const phases = await this.ensureExecutionPhases(missions);
      let priorHandoffRef: string | undefined;
      for (const phase of phases) {
        if (controller.signal.aborted) throw new Error(String(controller.signal.reason));
        if (['completed', 'blocked'].includes(phase.status)) {
          priorHandoffRef = phase.handoffOutRef ?? priorHandoffRef;
          continue;
        }
        const phaseMissions = missions.filter((mission) => mission.phase === phase.phaseKey);
        const completed = await this.executePhase({
          context: hostedContext,
          phase,
          phaseMissions,
          planDocument: plan.plan,
          priorHandoffRef,
          signal: controller.signal,
          emit,
          observeUsage,
        });
        priorHandoffRef = completed.handoffOutRef ?? priorHandoffRef;
        if (completed.status === 'failed') {
          throw new Error(`${completed.phaseKey} phase failed`);
        }
        if (completed.status === 'blocked') {
          await emit('run.blocked', {
            message: `${completed.phaseKey} phase ended blocked`,
            phaseId: completed.id,
          }, { phaseKey: completed.phaseKey });
        }
      }

      const findingCount = await this.currentFindingCount();
      const summary = this.codeReviewContext
        ? `Code Review completed ${phases.length + 1} phase(s) with ${findingCount} validated finding(s).`
        : `Shared pipeline completed ${phases.length + 1} phase(s) with ${findingCount} project finding(s).`;
      await this.persistence.markRunTerminal({ status: 'completed', summary });
      await emit('run.completed', {
        message: summary,
        phaseCount: phases.length + 1,
        findingCount,
        modelRequests: usage.modelRequests,
        recordedCost: usage.recordedCost,
      });
      return {
        runId,
        status: 'completed',
        phaseCount: phases.length + 1,
        findingCount,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = isCancellation(controller.signal);
      const paused = isPause(controller.signal);
      if (paused) {
        await this.persistence.markRunPaused({
          reason: String(controller.signal.reason ?? message),
          summary: 'Run paused with its plan, phases, findings, and artifacts preserved.',
        });
      } else {
        await this.persistence.markRunTerminal({
          status: cancelled ? 'cancelled' : 'failed',
          failure: message,
        });
      }
      await emit(paused ? 'run.paused' : cancelled ? 'run.cancelled' : 'run.failed', {
        message,
        reason: String(controller.signal.reason ?? ''),
        modelRequests: usage.modelRequests,
        recordedCost: usage.recordedCost,
      });
      return {
        runId,
        status: paused ? 'paused' : cancelled ? 'cancelled' : 'failed',
        phaseCount: (await this.persistence.listPhases()).length,
        findingCount: await this.currentFindingCount(),
        summary: message,
      };
    } finally {
      clearTimeout(wallTimer);
      unregister();
      this.controllers.delete(runId);
      await settleWithin(
        this.disposeRunSessions(runId),
        10_000,
        'hosted_run_session_cleanup_timeout',
      ).catch(async (error) => {
        await emit('run.cleanup.warning', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      this.activeSessionIds.delete(runId);
    }
  }

  private async currentFindingCount(): Promise<number> {
    if (this.codeReviewContext && this.persistence.queryCodeReviewFindings) {
      const result = await this.persistence.queryCodeReviewFindings({ state: 'validated' });
      return result.findings.length;
    }
    const findings = asRecord(await this.persistence.queryFindings({}));
    return Array.isArray(findings.findings) ? findings.findings.length : 0;
  }

  private async ensurePlan(
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> },
    signal: AbortSignal,
    emit: (
      type: string,
      data?: Record<string, unknown>,
      meta?: Pick<AgentRunEvent, 'phaseKey' | 'sessionId' | 'workerTaskId'>,
    ) => Promise<void>,
    observeUsage: (event: StreamEvent, meta: HostedUsageMeta) => void,
  ) {
    const existing = await this.persistence.getPlan();
    if (existing) return existing;

    const codeReview = this.codeReviewContext;
    const planningSkillSlugs = codeReview ? ['code-review-planning'] : ['securityops-planning'];
    const planningPhaseId = randomUUID();
    await this.persistence.createPhase({
      id: planningPhaseId,
      runId: this.persistence.runId,
      phaseKey: 'planning',
      ordinal: 0,
      handoffSchemaVersion: phaseProfileRegistry.get('planning').handoffSchemaVersion,
      assignedSkillSlugs: planningSkillSlugs,
      missionIds: [],
    });
    const flags = this.buildSecurityOpsFlags(context, {
      activePhaseId: planningPhaseId,
      activePhaseKey: 'planning',
      phaseAssignedSkillSlugs: planningSkillSlugs,
    });
    if (codeReview) {
      this.codeReviewMemoryPrompt = await this.buildHostedMemoryPrompt(codeReview);
    }
    const planner = await this.runtime.sessionStore.create({
      modelName: context.modelName,
      modelTemperature: 0,
      profileKey: 'phase-planning',
      promptProfile: codeReview ? 'code-review-planner' : 'planner',
      mode: 'automated',
      executionMode: 'discovery',
      agentType: 'planner',
      scopeId: context.workspaceId,
      flags,
      toolPolicy: filterHostedToolPolicy(
        phaseProfileRegistry.buildToolPolicy('planning', {
          whiteboxEnabled: true,
          connectedRepoCount: 1,
        }),
        'planning',
      ),
      extraContext: this.buildPlannerContext(context),
    });
    await this.persistence.activatePhase(planningPhaseId, planner.id);
    await this.prepareSharedWorkspace(planner, context);
    if (codeReview) {
      await syncAssignedSkillsIntoWorkspace(planningSkillSlugs, planner.workspaceDir);
    } else {
      await syncPlanningSkillIntoWorkspace(planner.workspaceDir);
    }
    await this.runtime.sandbox.create(planner);
    try {
      await this.runSession({
        session: planner,
        phaseKey: 'planning',
        prompt: `${PLANNER_KICKOFF_PROMPT}\n\n${this.hostedPlannerInstructions(context)}`,
        signal,
        emit,
        observeUsage,
        maxTurns: phaseProfileRegistry.get('planning').defaultBudget.maxTurns,
        isComplete: async () => Boolean(await this.persistence.getPlan()),
      });
    } finally {
      await this.exportSessionTranscript(planner, '00-planning');
    }
    const plan = await this.persistence.getPlan();
    if (!plan) throw new Error('Planner session ended without submit_plan');
    await this.persistence.submitPhaseHandoff({
      runId: this.persistence.runId,
      phaseId: planningPhaseId,
      phaseKey: 'planning',
      sessionId: planner.id,
      payload: {
        status: 'completed',
        summary: `Planner submitted ${plan.missions.length} mission(s).`,
        skillSlugs: plan.skillSlugs,
        missionCount: plan.missions.length,
      },
    });
    return plan;
  }

  private async ensureExecutionPhases(
    missions: ReturnType<typeof attachMissionPhases>,
  ): Promise<HostedRunPhase[]> {
    const existing = (await this.persistence.listPhases())
      .filter((phase) => phase.phaseKey !== 'planning');
    if (existing.length > 0) return existing.sort((left, right) => left.ordinal - right.ordinal);
    const orderedKeys: RunPhaseKey[] = [];
    if (this.codeReviewContext) {
      // The Code Review graph is fixed and ordered. The planner selects the
      // work inside each phase, never the phase sequence itself.
      orderedKeys.push(...CODE_REVIEW_PHASE_ORDER);
    } else {
      for (const mission of missions) {
        const phaseKey = mission.phase;
        if (!phaseKey || phaseKey === 'planning' || orderedKeys.includes(phaseKey)) continue;
        orderedKeys.push(phaseKey);
      }
      if (!orderedKeys.includes('reporting')) orderedKeys.push('reporting');
      if (orderedKeys[orderedKeys.length - 1] !== 'reporting') {
        orderedKeys.splice(orderedKeys.indexOf('reporting'), 1);
        orderedKeys.push('reporting');
      }
    }
    const phases: HostedRunPhase[] = [];
    for (const [index, phaseKey] of orderedKeys.entries()) {
      const phaseMissions = missions.filter((mission) => mission.phase === phaseKey);
      const canonicalSkill = CODE_REVIEW_PHASE_SKILL[phaseKey];
      const skills = canonicalSkill
        ? [canonicalSkill]
        : [...new Set(phaseMissions.flatMap((mission) => mission.assignedSkills ?? []))];
      phases.push(await this.persistence.createPhase({
        id: randomUUID(),
        runId: this.persistence.runId,
        phaseKey,
        ordinal: index + 1,
        handoffSchemaVersion: phaseProfileRegistry.get(phaseKey).handoffSchemaVersion,
        assignedSkillSlugs: skills,
        missionIds: phaseMissions.map((mission) => mission.id),
      }));
    }
    return phases;
  }

  private async executePhase(input: {
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> };
    phase: HostedRunPhase;
    phaseMissions: ReturnType<typeof attachMissionPhases>;
    planDocument: string;
    priorHandoffRef?: string;
    signal: AbortSignal;
    emit: (
      type: string,
      data?: Record<string, unknown>,
      meta?: Pick<AgentRunEvent, 'phaseKey' | 'sessionId' | 'workerTaskId'>,
    ) => Promise<void>;
    observeUsage: (event: StreamEvent, meta: HostedUsageMeta) => void;
  }): Promise<HostedRunPhase> {
    const profile = phaseProfileRegistry.get(input.phase.phaseKey);
    const flags = this.buildSecurityOpsFlags(input.context, {
      activePhaseId: input.phase.id,
      activePhaseKey: input.phase.phaseKey,
      phaseAssignedSkillSlugs: input.phase.assignedSkillSlugs,
    });
    const session = await this.runtime.sessionStore.create({
      modelName: input.context.modelName,
      modelTemperature: 0,
      profileKey: profile.phaseProfile,
      promptProfile: profile.promptProfile as PromptProfile,
      mode: 'automated',
      executionMode: executionModeForPhase(input.phase.phaseKey),
      agentType: 'executor',
      scopeId: input.context.workspaceId,
      flags,
      planSeed: buildPhasePlanSeed(
        input.phaseMissions,
        input.phase.missionIds,
        input.planDocument,
      ),
      toolPolicy: filterHostedToolPolicy(
        phaseProfileRegistry.buildToolPolicy(input.phase.phaseKey, {
          whiteboxEnabled: true,
          connectedRepoCount: 1,
        }),
        input.phase.phaseKey,
        {
          memoryWritable: this.codeReviewContext
            ? hostedReviewWritesDurableMemory(this.codeReviewContext)
            : false,
        },
      ),
      extraContext: this.buildPhaseContext(input),
    });
    await this.persistence.activatePhase(input.phase.id, session.id);
    await syncAssignedSkillsIntoWorkspace(input.phase.assignedSkillSlugs, session.workspaceDir);
    await this.runtime.sandbox.create(session);
    try {
      await this.runSession({
        session,
        phaseKey: input.phase.phaseKey,
        prompt: `${kickoffForPhase(input.phase.phaseKey)}\n\n${this.hostedPhaseInstructions(input.phase.phaseKey)}`,
        signal: input.signal,
        emit: input.emit,
        observeUsage: input.observeUsage,
        maxTurns: profile.defaultBudget.maxTurns,
        isComplete: async () => {
          const current = (await this.persistence.listPhases())
            .find((phase) => phase.id === input.phase.id);
          return Boolean(current && current.status !== 'active' && current.status !== 'pending');
        },
      });
    } finally {
      await this.exportSessionTranscript(
        session,
        `${String(input.phase.ordinal).padStart(2, '0')}-${input.phase.phaseKey}`,
      );
    }
    if (input.phase.phaseKey === 'reporting' || input.phase.phaseKey === 'review_reporting') {
      await this.exportKnownReportFiles(session);
    }
    const completed = (await this.persistence.listPhases())
      .find((phase) => phase.id === input.phase.id);
    if (!completed || completed.status === 'active' || completed.status === 'pending') {
      throw new Error(`${input.phase.phaseKey} session ended without submit_phase_handoff`);
    }
    const live = this.runtime.sessionStore.get(session.id);
    for (const task of live?.workerTasks ?? []) {
      await input.emit('worker.terminal', {
        message: `${task.workerType} ${task.status}`,
        status: task.status,
        workerType: task.workerType,
        workerSessionId: task.workerSessionId,
        result: compact(task.artifact),
      }, {
        phaseKey: input.phase.phaseKey,
        sessionId: session.id,
        workerTaskId: task.taskId,
      });
    }
    return completed;
  }

  private async runSession(input: {
    session: SessionState;
    phaseKey: RunPhaseKey;
    prompt: string;
    signal: AbortSignal;
    maxTurns: number;
    isComplete: () => Promise<boolean>;
    emit: (
      type: string,
      data?: Record<string, unknown>,
      meta?: Pick<AgentRunEvent, 'phaseKey' | 'sessionId' | 'workerTaskId'>,
    ) => Promise<void>;
    observeUsage: (event: StreamEvent, meta: HostedUsageMeta) => void;
  }): Promise<void> {
    const active = this.activeSessionIds.get(this.persistence.runId);
    active?.add(input.session.id);
    // Last error this turn, captured so the loop can tell a halted turn from a
    // turn that ran and simply did not finish. A pre-turn halt emits an error
    // and consumes no model call, so without this the loop retries a condition
    // that cannot change and reports the turn budget instead of the cause.
    // Held in a ref because the subscriber below assigns it from a callback:
    // control-flow narrowing on a plain local would collapse it to `never`.
    const turnErrorRef: { current?: { code: string; message: string } } = {};
    /**
     * Read and clear the error seen during the current turn.
     *
     * Read through a call rather than a property so control-flow analysis uses
     * the declared return type: assigning `undefined` to the ref narrows the
     * property, and that narrowing survives into any local read from it.
     */
    const takeTurnError = (): { code: string; message: string } | undefined => {
      const seen = turnErrorRef.current;
      turnErrorRef.current = undefined;
      return seen;
    };
    const unsubscribe = this.runtime.streamBroker.subscribe(input.session.id, (event) => {
      input.observeUsage(event, {
        phaseKey: input.phaseKey,
        sessionId: input.session.id,
      });
      const mapped = this.mapStreamEvent(event);
      if (!mapped) return;
      if (mapped.type === 'agent.error') {
        const code = typeof mapped.data?.code === 'string' ? mapped.data.code : 'unknown';
        const message = typeof mapped.data?.message === 'string'
          ? mapped.data.message
          : 'agent error';
        turnErrorRef.current = { code, message };
      }
      void input.emit(mapped.type, mapped.data, {
        phaseKey: input.phaseKey,
        sessionId: input.session.id,
      });
    });
    const abort = (): void => {
      const reason = String(input.signal.reason ?? 'hosted_run_aborted');
      void this.runtime.sessionStore.abortCurrentTurnAsync(input.session.id, reason).catch(() => undefined);
      const live = this.runtime.sessionStore.get(input.session.id);
      if (live) void this.runtime.sandbox.stop(live, reason).catch(() => undefined);
    };
    if (input.signal.aborted) {
      abort();
      throw new Error(String(input.signal.reason));
    }
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      await input.emit('session.started', {
        message: `${input.phaseKey} agent session started`,
        promptProfile: input.session.promptProfile,
        toolPolicy: input.session.toolPolicy,
      }, { phaseKey: input.phaseKey, sessionId: input.session.id });
      // A turn that fails the same way twice is not making progress. Both
      // observed cases — an authorization halt and a model with no configured
      // API key — repeated identically until the budget ran out, then reported
      // the turn count rather than the cause. Two turns is enough to tell a
      // transient error from a standing one.
      let lastError: { code: string; message: string } | undefined;
      for (let turn = 0; turn < input.maxTurns; turn += 1) {
        if (input.signal.aborted) throw new Error(String(input.signal.reason));
        await input.emit('session.turn.started', {
          message: `${input.phaseKey} engine turn ${turn + 1}`,
          turn: turn + 1,
          maxTurns: input.maxTurns,
        }, { phaseKey: input.phaseKey, sessionId: input.session.id });
        const liveSession = this.runtime.sessionStore.get(input.session.id) ?? input.session;
        await this.runtime.sandbox.create(liveSession);
        await this.runtime.orchestrator.processMessage(
          input.session.id,
          turn === 0 ? input.prompt : '',
          input.session.promptProfile,
          undefined,
          {
            visibility: 'internal',
            source: input.phaseKey === 'planning' ? 'planner_kickoff' : 'executor_kickoff',
          },
        );
        if (input.signal.aborted) throw new Error(String(input.signal.reason));
        if (await input.isComplete()) return;

        const turnError = takeTurnError();
        if (turnError) lastError = turnError;

        // A blocked session cannot continue until something outside this loop
        // resumes it, so every remaining turn would only re-emit "this session
        // is blocked". Stop on the first one and report the error that caused
        // it rather than the turn budget.
        const blockedReason = this.runtime.sessionStore.get(input.session.id)?.blockedReason;
        if (blockedReason) {
          throw new Error(
            lastError
              ? `${input.phaseKey} halted on turn ${turn + 1}: ${lastError.message}`
                + ` (${lastError.code}); session blocked (${blockedReason})`
              : `${input.phaseKey} halted on turn ${turn + 1}: session blocked (${blockedReason})`,
          );
        }
      }
      throw new Error(
        lastError
          ? `${input.phaseKey} session exhausted ${input.maxTurns} engine turns without its`
            + ` required exit tool; last error was ${lastError.message} (${lastError.code})`
          : `${input.phaseKey} session exhausted ${input.maxTurns} engine turns without its required exit tool`,
      );
    } finally {
      input.signal.removeEventListener('abort', abort);
      unsubscribe();
      active?.delete(input.session.id);
    }
  }

  private buildSecurityOpsFlags(
    context: AgentRunHostContext,
    phase: {
      activePhaseId: string;
      activePhaseKey: RunPhaseKey;
      phaseAssignedSkillSlugs: string[];
    },
  ): SessionState['flags'] {
    const codeReview = this.codeReviewContext;
    return {
      securityops: {
        runHost: 'research_lab',
        runId: this.persistence.runId,
        organizationId: 'research-lab',
        scopeId: context.workspaceId,
        // Which authorization question this run must answer. Absent means
        // target_ownership — a host cannot opt out of authorization by omission.
        authorizationModel: context.authorizationModel ?? 'target_ownership',
        workflowDiscipline: codeReview ? 'code_review' : 'pentest',
        ...(codeReview
          ? {
              codeReviewOperation: codeReview.operation,
              codeReview,
              codeReviewMemoryWritable: hostedReviewWritesDurableMemory(codeReview),
            }
          : {}),
        sourceMode: context.sourceMode,
        activePhaseId: phase.activePhaseId,
        activePhaseKey: phase.activePhaseKey,
        phaseAssignedSkillSlugs: phase.phaseAssignedSkillSlugs,
        maxActiveWorkers: 5,
        repository: context.repository,
      },
      research_lab: {
        projectId: context.workspaceId,
        runId: this.persistence.runId,
        engineIntegration: 'shared_pipeline',
      },
    };
  }

  /**
   * Build the advisory repository-memory section for a hosted Code Review run.
   *
   * Memory is never authoritative: the snapshot labels every entry as current
   * or needing re-verification, and the prompts forbid validating or
   * suppressing a finding from memory alone.
   */
  private async buildHostedMemoryPrompt(context: CodeReviewContext): Promise<string> {
    if (!this.persistence.buildCodeReviewMemorySnapshot) return '';
    try {
      const snapshot = await this.persistence.buildCodeReviewMemorySnapshot({
        manifestFiles: this.codeReviewManifest,
        immutableCommitSha: context.repository.immutableCommitSha,
        manifestCompleteness: context.reviewScope.completeness,
        allowedPaths: context.reviewScope.allowedPaths,
        excludedPaths: context.reviewScope.excludedPaths,
      });
      return snapshot.promptText?.trim() ?? '';
    } catch {
      // Memory is an optimization. A snapshot failure must never block a
      // review, because a review that reads the source is always correct.
      return '';
    }
  }

  private buildCodeReviewPlannerContext(
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> },
    codeReview: CodeReviewContext,
  ): string {
    return [
      '=== CODE REVIEW RUN CONTEXT ===',
      JSON.stringify(codeReview, null, 2),
      '',
      '=== HOST BOUNDARY ===',
      'Host: Research Lab local clone. No GitHub credential, no network target, no repository write, and no publication authority exist in this run.',
      `Repository: ${context.repository.url}`,
      `Pinned commit: ${context.repository.commit}`,
      'Source is served only through the immutable Code Review manifest, search, and file-read tools.',
      '',
      ...(this.codeReviewMemoryPrompt ? [this.codeReviewMemoryPrompt, ''] : []),
      buildHostedAssignedMethodContext(['code-review-planning']),
      '',
      `=== RUN GOAL ===\n${context.objective}`,
    ].join('\n');
  }

  private buildPlannerContext(
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> },
  ): string {
    const codeReview = this.codeReviewContext;
    if (codeReview) return this.buildCodeReviewPlannerContext(context, codeReview);
    return [
      '=== TARGET CONTEXT ===',
      `Goal: ${context.objective}`,
      'Authorized mode: local, read-only white-box repository research.',
      `Repository: ${context.repository.url}`,
      `Ref: ${context.repository.ref}`,
      `Pinned commit: ${context.repository.commit}`,
      'Repository files are mounted at /workspace/repository and exposed by connected repository tools.',
      'No live target is authorized. Do not perform external writes or maintainer contact.',
      '',
      buildHostedAssignedMethodContext(['securityops-planning']),
      '',
      '=== RESEARCH LAB PROJECT MEMORY ===',
      'Use query_notes and project files for prior attempts, blockers, and coverage.',
    ].join('\n');
  }

  private hostedPlannerInstructions(
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> },
  ): string {
    if (this.codeReviewContext) {
      return [
        'RESEARCH LAB HOST POLICY (CODE REVIEW):',
        'Submit exactly four ordered missions using phase=review_mapping, review_analysis, review_validation, and review_reporting.',
        'Assign exactly one skill per mission: code-review-mapping, code-review-analysis, code-review-validation, and code-review-reporting respectively.',
        'Set skillSlugs to exactly those four slugs.',
        'Do not select Pentest or Compliance phases. recon, enumeration, validation, exploitation, evidence, control_assessment, and reporting are rejected in this discipline.',
        'Planning is bounded: use list_code_review_repository_files and at most a few targeted reads to learn the languages and top-level structure before submitting.',
        'Do not review source in depth during planning. Analysis belongs to review_analysis.',
        'No live target, repository write, patch, or GitHub publication authority exists. Do not plan any.',
        'Prior repository memory is advisory. Never plan to accept a memory statement as proof or to skip reading source because memory covered it.',
      ].join('\n');
    }
    return [
      'RESEARCH LAB HOST POLICY:',
      `Plan a static, white-box review of the pinned repository ${context.repository.url}.`,
      'Use three or four focused missions. Include source enumeration, independent validation, and reporting.',
      'Planning is bounded: inspect only the repository root, README, and at most two build or dependency manifests before submitting the plan.',
      'Do not review source files during planning. Source review belongs to the enumeration mission.',
      'Submit the plan as soon as repository language and top-level structure are known; target no more than three planner model responses.',
      'Use phase="enumeration" for source review, phase="validation" for independent confirmation, and phase="reporting" for closeout.',
      'Choose one or two active vulnerability skills appropriate to the source evidence. Prefer source-aware-whitebox and a precise class skill.',
      'The validation mission must permit a repo_research_worker to independently trace the suspected code path.',
      'Do not select exploitation or control_assessment. Do not deploy the application or contact external systems.',
      'The reporting mission still uses security-reporting, but hosted closeout ends with submit_phase_handoff after writing summary.md and report.md.',
    ].join('\n');
  }

  private buildPhaseContext(input: {
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> };
    phase: HostedRunPhase;
    phaseMissions: ReturnType<typeof attachMissionPhases>;
    planDocument: string;
    priorHandoffRef?: string;
  }): string {
    const codeReview = this.codeReviewContext;
    if (codeReview) {
      return [
        '=== CODE REVIEW RUN CONTEXT ===',
        JSON.stringify(codeReview, null, 2),
        '',
        '=== HOST BOUNDARY ===',
        'Host: Research Lab local clone. No GitHub credential, network target, repository write, or publication authority exists.',
        '',
        ...(this.codeReviewMemoryPrompt ? [this.codeReviewMemoryPrompt, ''] : []),
        '=== ACTIVE RUN PHASE ===',
        `phase: ${input.phase.phaseKey}`,
        `phaseId: ${input.phase.id}`,
        `ordinal: ${input.phase.ordinal}`,
        input.priorHandoffRef ? `handoffInRef: ${input.priorHandoffRef}` : '',
        '',
        buildHostedAssignedMethodContext(input.phase.assignedSkillSlugs),
        '',
        '=== PHASE MISSIONS ===',
        JSON.stringify(input.phaseMissions, null, 2),
      ].filter(Boolean).join('\n');
    }
    return [
      '=== TARGET CONTEXT ===',
      `Goal: ${input.context.objective}`,
      `Repository: ${input.context.repository.url}`,
      `Ref: ${input.context.repository.ref}`,
      `Pinned commit: ${input.context.repository.commit}`,
      'Source path: /workspace/repository',
      'Execution boundary: local static analysis and bounded local reproduction only. No external writes or maintainer contact.',
      '',
      '=== ACTIVE RUN PHASE ===',
      `phase: ${input.phase.phaseKey}`,
      `phaseId: ${input.phase.id}`,
      `ordinal: ${input.phase.ordinal}`,
      input.priorHandoffRef ? `handoffInRef: ${input.priorHandoffRef}` : '',
      '',
      buildHostedAssignedMethodContext(input.phase.assignedSkillSlugs),
      '',
      '=== PHASE MISSIONS ===',
      JSON.stringify(input.phaseMissions, null, 2),
    ].filter(Boolean).join('\n');
  }

  private hostedPhaseInstructions(phaseKey: RunPhaseKey): string {
    if (this.codeReviewContext) return this.hostedCodeReviewPhaseInstructions(phaseKey);
    const shared = [
      'RESEARCH LAB HOST POLICY:',
      'Work only on the pinned local repository. Network target activity and external writes are unavailable.',
      'Use connected repository tools for read-only source access and shell/python only for bounded local proof.',
      'Persist candidates with report_finding and finish with submit_phase_handoff.',
    ];
    if (phaseKey === 'validation') {
      shared.push(
        'Spawn one repo_research_worker for an independent source trace, wait for its result, and incorporate it before handoff.',
        'When proof confirms a real issue, call report_finding with durable file/code evidence.',
      );
    }
    if (phaseKey === 'reporting') {
      shared.push(
        'Read project findings with query_findings.',
        'Write /workspace/summary.md and /workspace/report.md directly, then call submit_phase_handoff.',
        'Hosted reporting does not call prepare_report_context, report_note, report_finalizer_preflight, or finalize_run_artifacts.',
      );
    }
    return shared.join('\n');
  }

  private hostedCodeReviewPhaseInstructions(phaseKey: RunPhaseKey): string {
    const memoryWritable = this.codeReviewContext
      ? hostedReviewWritesDurableMemory(this.codeReviewContext)
      : false;
    const shared = [
      'RESEARCH LAB HOST POLICY (CODE REVIEW):',
      'Read source only through list_code_review_repository_files, search_code_review_repository, and read_connected_repository_file at the pinned immutable commit.',
      'No live target, repository write, patch generation, or GitHub publication authority exists in this run.',
      'Prior repository memory is advisory. A needs_recheck entry is a question, and a prior rejected disposition never blocks a fresh candidate.',
      'Never validate or suppress a finding from memory alone; read the relevant source at this commit.',
      'Finish with submit_phase_handoff.',
    ];
    if (phaseKey === 'review_mapping') {
      shared.push(
        'Map architecture, entrypoints, trust boundaries, authorization, data flows, dependencies, and tests. Do not report vulnerabilities.',
        memoryWritable
          ? 'Record durable architecture facts with record_code_review_memory type="review.map", citing exact manifest paths.'
          : 'Durable memory writes are unavailable for this run; record findings-relevant context in the handoff instead.',
      );
    }
    if (phaseKey === 'review_analysis') {
      shared.push(
        'Create source-attributed candidates with report_code_review_candidate and exact code locations. Pattern matches are not findings.',
        'Memory is a lead source only. Query it, then verify against current source.',
      );
    }
    if (phaseKey === 'review_validation') {
      shared.push(
        'Resolve every candidate with validate_code_review_finding, including an agent-owned fixable, not_fixable, or uncertain judgement.',
        'This phase cannot complete while any candidate is unresolved.',
        memoryWritable
          ? 'Record durable dispositions with record_code_review_memory type="review.disposition" so a later review does not rediscover a rejected candidate.'
          : 'Durable memory writes are unavailable for this run.',
      );
    }
    if (phaseKey === 'review_reporting') {
      shared.push(
        'Read canonical outcomes with query_code_review_findings and finalize with finalize_code_review_report.',
        'Give an honest complete, partial, or blocked completeness decision. A complete manifest does not prove complete review coverage.',
        memoryWritable
          ? 'Record what was and was not reviewed with record_code_review_memory type="review.coverage".'
          : 'Durable memory writes are unavailable for this run.',
        'Never call Pentest report tools.',
      );
    }
    return shared.join('\n');
  }

  private async prepareSharedWorkspace(
    session: SessionState,
    context: AgentRunHostContext & { repository: NonNullable<AgentRunHostContext['repository']> },
  ): Promise<void> {
    const source = path.resolve(context.repository.localPath);
    const target = path.resolve(session.workspaceDir, 'repository');
    const sourceStat = await fs.stat(source);
    if (!sourceStat.isDirectory()) throw new Error(`Repository localPath is not a directory: ${source}`);
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
    await this.copyRepository(source, target);
    await Promise.all([
      fs.mkdir(path.resolve(session.workspaceDir, 'journal'), { recursive: true }),
      fs.mkdir(path.resolve(session.workspaceDir, 'findings'), { recursive: true }),
      fs.mkdir(path.resolve(session.workspaceDir, 'evidence'), { recursive: true }),
      fs.mkdir(path.resolve(session.workspaceDir, '.artifacts', 'phases'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.resolve(session.workspaceDir, 'AGENTS.md'), [
        '# Research Lab shared run',
        '',
        'This is a file-backed Research Lab project executing through the shared NullSquare agent engine.',
        'Repository source is read-only by policy. Do not contact maintainers or write to external systems.',
        '',
      ].join('\n'), 'utf8'),
      fs.writeFile(path.resolve(session.workspaceDir, 'journal', 'model.md'), [
        '# Engagement model',
        '',
        `Repository: ${context.repository.url}`,
        `Commit: ${context.repository.commit}`,
        'Mode: white-box local repository research',
        '',
      ].join('\n'), 'utf8'),
      fs.writeFile(path.resolve(session.workspaceDir, 'journal', 'coverage.md'), '# Coverage\n\nNo phase coverage recorded yet.\n', 'utf8'),
      fs.writeFile(path.resolve(session.workspaceDir, 'journal', 'leads.md'), '# Leads\n\nNo leads recorded yet.\n', 'utf8'),
      fs.writeFile(path.resolve(session.workspaceDir, 'findings', 'index.md'), '# Findings\n\nUse query_findings for canonical project findings.\n', 'utf8'),
      fs.writeFile(path.resolve(session.workspaceDir, 'evidence', 'manifest.json'), '{"schemaVersion":1,"artifacts":[]}\n', 'utf8'),
    ]);
  }

  private async copyRepository(source: string, target: string): Promise<void> {
    let files = 0;
    let bytes = 0;
    const walk = async (from: string, to: string): Promise<void> => {
      const entries = await fs.readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && SKIPPED_SOURCE_DIRECTORIES.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const sourcePath = path.resolve(from, entry.name);
        const targetPath = path.resolve(to, entry.name);
        if (entry.isDirectory()) {
          await fs.mkdir(targetPath, { recursive: true });
          await walk(sourcePath, targetPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(sourcePath);
        files += 1;
        bytes += stat.size;
        if (files > 25_000 || bytes > 300 * 1024 * 1024) {
          throw new Error('Repository exceeds hosted workspace copy limit (25,000 files or 300 MiB)');
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
      }
    };
    await walk(source, target);
  }

  private mapStreamEvent(event: StreamEvent): { type: string; data: Record<string, unknown> } | null {
    const data = asRecord('data' in event ? event.data : undefined);
    switch (event.type) {
      case 'usage.recorded':
        return { type: 'agent.usage', data: { message: 'Model usage recorded', ...data } };
      case 'tool_started':
        return {
          type: 'agent.tool.started',
          data: {
            message: `Tool started: ${event.data.name}`,
            name: event.data.name,
            args: compact(event.data.args),
            toolCallId: event.data.toolCallId,
          },
        };
      case 'tool_output':
        return {
          type: 'agent.tool.output',
          data: {
            message: `${event.data.name}: ${String(compact(event.data.chunk, 1000))}`,
            name: event.data.name,
            chunk: compact(event.data.chunk, 4000),
          },
        };
      case 'tool_result':
        return {
          type: 'agent.tool.result',
          data: {
            message: `Tool completed: ${event.data.name}`,
            name: event.data.name,
            result: compact(event.data.result),
            toolCallId: event.data.toolCallId,
          },
        };
      case 'message':
        return {
          type: 'agent.message',
          data: {
            message: `${event.data.role}: ${String(compact(event.data.content, 1000))}`,
            role: event.data.role,
            content: compact(event.data.content),
          },
        };
      case 'token':
        return { type: 'agent.token', data: { message: 'token', chunk: event.data } };
      case 'plan_update':
        return { type: 'agent.plan', data: { message: 'Agent plan updated', plan: event.data } };
      case 'warning':
        return { type: 'agent.warning', data: { message: String(compact(event.data, 1000)), ...data } };
      case 'error':
        return { type: 'agent.error', data: { message: String(compact(event.data, 1000)), ...data } };
      case 'done':
      case 'message_end':
        return { type: 'agent.done', data: { message: 'Agent turn completed' } };
      case 'message_start':
      case 'ping':
        return null;
      default:
        return { type: `agent.${event.type}`, data: { message: event.type, ...data } };
    }
  }

  private async exportSessionTranscript(session: SessionState, name: string): Promise<void> {
    const live = this.runtime.sessionStore.get(session.id) ?? session;
    const content = live.messages.map((message, index) => [
      `## ${index + 1}. ${message.role}`,
      '',
      message.content || '(empty)',
      '',
    ].join('\n')).join('\n');
    await this.persistence.writeRunArtifact(`report/transcripts/${name}.md`, content);
  }

  private async exportKnownReportFiles(session: SessionState): Promise<void> {
    const exported = new Set<string>();
    for (const fileName of ['summary.md', 'report.md']) {
      try {
        const content = await this.runtime.sandbox.readFile(
          session,
          `/workspace/${fileName}`,
          5 * 1024 * 1024,
        );
        await this.persistence.writeRunArtifact(`report/${fileName}`, content);
        exported.add(fileName);
      } catch {
        // The durable handoff fallback below retains the authored closeout
        // even if the session sandbox was replaced during worker cleanup.
      }
    }
    if (exported.size === 2) return;

    const reportingPhaseKey: RunPhaseKey = this.codeReviewContext ? 'review_reporting' : 'reporting';
    const reporting = (await this.persistence.listPhases())
      .find((phase) => phase.phaseKey === reportingPhaseKey);
    if (!reporting?.handoffOutRef) return;
    const handoff = asRecord(JSON.parse(
      (await this.persistence.readRunArtifact(reporting.handoffOutRef)).toString('utf8'),
    ));
    const summary = String(handoff.summary ?? 'Repository research completed.');
    const completedObjectives = Array.isArray(handoff.completedObjectives)
      ? handoff.completedObjectives.map(String)
      : [];
    const unresolvedQuestions = Array.isArray(handoff.unresolvedQuestions)
      ? handoff.unresolvedQuestions.map(String)
      : [];
    const evidenceRefs = Array.isArray(handoff.evidenceRefs)
      ? handoff.evidenceRefs.map(String)
      : [];
    const closeoutOutcome = String(handoff.closeoutOutcome ?? 'completed');

    if (!exported.has('summary.md')) {
      await this.persistence.writeRunArtifact('report/summary.md', [
        '# Repository research summary',
        '',
        summary,
        '',
        `Closeout: ${closeoutOutcome}`,
        '',
      ].join('\n'));
    }
    if (!exported.has('report.md')) {
      const section = (title: string, values: string[], empty: string): string[] => [
        `## ${title}`,
        '',
        ...(values.length > 0 ? values.map((value) => `- ${value}`) : [empty]),
        '',
      ];
      await this.persistence.writeRunArtifact('report/report.md', [
        '# Repository research report',
        '',
        summary,
        '',
        ...section('Completed objectives', completedObjectives, 'No objectives were recorded.'),
        ...section('Evidence references', evidenceRefs, 'No separate evidence references were recorded.'),
        ...section('Unresolved questions', unresolvedQuestions, 'None.'),
        `Closeout outcome: ${closeoutOutcome}`,
        '',
        `Canonical phase handoff: ${reporting.handoffOutRef}`,
        '',
      ].join('\n'));
    }
  }

  private async disposeRunSessions(runId: string): Promise<void> {
    const sessions = this.runtime.sessionStore.listByRunId(runId);
    await Promise.allSettled(sessions.map(async (session) => {
      await this.runtime.sessionStore.updateSessionAsync(session.id, (current) => {
        current.completed = true;
        return true;
      });
      await this.runtime.sessionStore.removeAsync(session.id, 'explicit');
    }));
    await this.runtime.sessionStore.cleanupRunWorkspaceAsync(runId, {
      force: true,
      persist: false,
      reason: 'shared_hosted_run_closeout',
    });
  }
}
