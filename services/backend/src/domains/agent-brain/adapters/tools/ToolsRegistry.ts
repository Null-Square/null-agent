import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { type StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import { type CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import {
  type ApprovalPreview,
  type EnumerationMissionV1,
  type PlanItem,
  type EnumerationServerAttemptRecordV1,
  type SessionFlags,
  type StepStatus,
  type SessionState,
  type ToolExecutionOutcome,
  type ToolExecutionReceiptV1,
  type ToolDefinition,
} from '../../domain/types';
import { type SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { type SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import type { ToolManifest } from '../../domain/manifests';
import { ToolManifestRegistry } from '@/domains/agent-brain/infrastructure/manifests/ToolManifestRegistry';
import type { ToolArgs, ToolModuleDefinition } from '@/domains/agent-brain/application/tools/types';
import type { ToolMeta } from '@/domains/agent-brain/application/tools/runtime/Tool';
import { PlanRuntime } from '@/domains/agent-brain/application/tools/runtime/PlanRuntime';
import { isResumablePlanBlockReason } from '@/domains/agent-brain/domain/helpers/PlanState';
// SIMPLIFIED Dec 2025: Replaced complex ApprovalService with SimpleApprovalHelper
import { SimpleApprovalHelper, ApprovalDeniedError } from '@/domains/agent-brain/application/services/SimpleApprovalHelper';
import {
  ToolLifecycleHookRegistry,
  TOOL_EXECUTION_PIPELINE_SCHEMA,
  ToolPipelineInvariantError,
  ToolPolicyChecker,
  advanceToolExecutionPipeline,
  createToolExecutionPipelineContext,
  freezeToolExecutionResult,
  type ToolExecutionPipelineContext,
  type ToolPermissionDecision,
  type ToolUseDescriptor,
} from '@/domains/agent-brain/application/tools';
import { ToolTelemetry } from '@/domains/agent-brain/adapters/tools/ToolTelemetry';
import type { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';
import { logger } from '@/shared/logger';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type {
  ToolExecutionOptions,
  ToolExecutionPort,
  ToolExecutionRecord,
  ToolExecutionWithReceipt,
} from '@/domains/agent-brain/ports';
import {
  normalizeToolExecutionStatus,
  supportsDurableToolExecutionLifecycle,
} from '@/domains/agent-brain/ports';
import type {
  WorkspaceProjectionFlushOptions,
  WorkspaceProjectionFlushResult,
} from '@/domains/agent-brain/ports';
import type { ResolvedConfig } from '@/config/configTypes';
import { PathGuard, CmdGuard } from '@/domains/agent-brain/application/tools/runtime/Guards';
import {
  resolveWorkerWriteScope,
  isArtifactScopedWriteScope,
  type ToolBudgetSnapshot,
  WORKER_WRITE_SCOPE_SAFE_TOOLS,
  WORKER_WRITE_SCOPE_UNSCOPED_TOOLS,
  WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS,
} from '@/domains/agent-brain/domain/workers/workerContracts';
import {
  assessEnumerationWorkerToolUse,
  type EnumerationRuntimeGuardDecision,
} from '@/domains/agent-brain/domain/workers/enumerationRuntimeGuard';
import {
  assessAttackWorkerToolUse,
  type AttackRuntimeGuardDecision,
} from '@/domains/agent-brain/domain/workers/attackRuntimeGuard';
import { buildEnumerationAttemptReservation } from '@/domains/agent-brain/domain/workers/enumerationContracts';
import { createAttemptKey } from '@/domains/agent-brain/domain/types/memory';
import { toolContractRegistry } from '@/domains/agent-brain/application/tools/ToolContractRegistry';
import { JsonRepairService } from '@/domains/agent-brain/application/services/JsonRepairService';
import type { ToolContext as RuntimeToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import type { ToolResult as RuntimeToolResult } from '@/domains/agent-brain/application/tools/runtime/Tool';
import type { StreamBroker as ToolCallStreamBroker } from '@/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import { flushWorkspaceProjectionForSession } from '@/domains/security-ops/workspace/workspaceProjectionRuntime';
import { getEnumerationWorkerAdmissionState } from '@/domains/security-ops/runs/enumerationCapability';
import { getControlledExploitationAdmissionState } from '@/domains/security-ops/runs/exploitationCapability';
import {
  getHostedRunRuntimeCapabilities,
  getHostedRunToolExecutionLifecycle,
} from '@/domains/security-ops/runs/HostedRunPersistencePort';
import {
  RuntimeHostCapabilityRegistrationError,
  type PersistenceCapability,
  type RuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { workCancellationRegistry } from '@/domains/agent-brain/application/orchestration/services/WorkContinuationGuard';
import { buildInterruptedToolRecoveryProjection } from '@/domains/agent-brain/domain/recovery/interruptedToolResult';
import {
  enumerationWorkerAttemptTotal,
  enumerationWorkerTargetRequestTotal,
} from '@/shared/metrics/prometheusMetrics';

const PROVENANCE_SNIPPET_LIMIT = 512;

const PLAN_MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  'plan_set_step_status',
  'todo_write',
  'todo_read',
]);
const WORKER_PLAN_BINDING_FLAG_NAMESPACE = 'worker_plan_binding';
const WORKER_PLAN_BINDING_FLAG_TURN_ID = 'turnId';
const WORKER_PLAN_BINDING_FLAG_STEP_IDS = 'pendingStepIds';

type WorkerPlanBindingState = {
  turnId: string;
  pendingStepIds: string[];
};

type EnumerationRequestReservation = {
  requestCost: number;
  requestConcurrency: number;
  attempt?: EnumerationServerAttemptRecordV1;
};

type AttackRequestReservation = {
  requestCost: number;
  requestConcurrency: number;
};

interface ToolExecutionContext {
  sessionId: string;
  modelRequestId?: string;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  turnNumber?: number;
  turnId?: string;
  budget?: ToolBudgetSnapshot;
  rawArgsJson?: string;
  stream?: ToolCallStreamBroker;
  executeModelCall?: ToolExecutionOptions['executeModelCall'];
  captureRuntimeOutcome?: (outcome: ToolExecutionOutcome) => void;
  capturePipelineContext?: (pipeline: ToolExecutionPipelineContext) => void;
}

const INVALID_TOOL_ARGS_ERROR_CODE = 'tool_args.invalid_json';
const TOOL_ARGS_PREVIEW_LIMIT = 300;

const SELF_STREAMING_TOOLS = new Set([
  'bash_exec', 'bash_execute', 'shell_run', 'shell_exec', 'execute_command', 'run_command',
]);

type HostedToolExecutionSelection = {
  capability: PersistenceCapability;
  lifecycle: ToolExecutionPort;
};

const resolveHostedToolExecutionSelection = (
  session: SessionState | undefined,
): HostedToolExecutionSelection | null => {
  const securityops = session?.flags?.securityops;
  if (typeof securityops !== 'object' || securityops === null || Array.isArray(securityops)) {
    return null;
  }
  const flags = securityops as Record<string, unknown>;
  if (flags.runHost !== 'research_lab') return null;
  const context = {
    runId: typeof flags.runId === 'string' ? flags.runId : undefined,
    runHost: typeof flags.runHost === 'string' ? flags.runHost : undefined,
  };
  const capabilities = getHostedRunRuntimeCapabilities(context);
  if (!capabilities) return null;
  const lifecycle = getHostedRunToolExecutionLifecycle(context);
  if (!lifecycle) {
    throw new RuntimeHostCapabilityRegistrationError([
      `host=research_lab runId=${String(context.runId)} lifecycle=toolExecutions adapter=missing`,
    ]);
  }
  return { capability: capabilities.toolExecutions, lifecycle };
};

function buildStartLabel(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'http_payload':
    case 'http_request': {
      const method = String(args['method'] ?? 'GET').toUpperCase();
      const url = String(args['url'] ?? args['uri'] ?? '');
      return url ? `${method} ${url}` : toolName;
    }
    case 'http_raw_send': {
      const url = String(args['url'] ?? '');
      const count = Array.isArray(args['requests']) ? args['requests'].length : 1;
      return url ? `RAW ${url}${count > 1 ? ` (${count} requests)` : ''}` : toolName;
    }
    case 'python_session': {
      const action = String(args['action'] ?? 'exec');
      const label = typeof args['label'] === 'string' && args['label'].trim().length > 0
        ? `: ${args['label']}`
        : '';
      return `python_session ${action}${label}`;
    }
    case 'query_notes':
      return `query_notes${args['ntype'] ? ` [ntype=${args['ntype']}]` : ''}`;
    case 'query_findings':
      return `query_findings${args['status'] ? ` [status=${args['status']}]` : ''}`;
    case 'query_inventory':
      return `query_inventory${args['assetType'] ? ` [type=${args['assetType']}]` : ''}`;
    case 'ingest_scan_artifact':
      return `ingest_scan_artifact: ${String(args['parser'] ?? '')} ${String(args['artifactPath'] ?? '')}`.trim();
    case 'submit_plan':
      return 'submit_plan';
    case 'report_finding':
      return `report_finding: ${String(args['title'] ?? '')}`;
    case 'submit_phase_handoff':
      return `submit_phase_handoff: ${String(args['status'] ?? '')}`;
    case 'submit_phase_checkpoint':
      return 'submit_phase_checkpoint';
    case 'recon_handoff_preflight':
    case 'enumeration_handoff_preflight':
    case 'validation_handoff_preflight':
    case 'evidence_handoff_preflight':
    case 'reporting_handoff_preflight':
      return `${toolName}: ${String(args['status'] ?? 'check')}`;
    case 'promote_finding':
      return `promote_finding: ${String(args['findingId'] ?? '')}`;
    case 'record_control_check':
      return `record_control_check: ${String(args['frameworkKey'] ?? '')}/${String(args['controlId'] ?? '')} ${String(args['verdict'] ?? '')}`.trim();
    case 'record_control_request':
      return `record_control_request: ${String(args['frameworkKey'] ?? '')}/${String(args['controlId'] ?? '')} ${String(args['requestType'] ?? '')}`.trim();
    case 'review_control_request':
      return `review_control_request: ${String(args['requestId'] ?? '')} ${String(args['outcome'] ?? '')}`.trim();
    case 'map_compliance_evidence':
      return `map_compliance_evidence: ${String(args['evidenceItemId'] ?? '')}`.trim();
    case 'annotate_compliance_evidence':
      return `annotate_compliance_evidence: ${String(args['evidenceItemId'] ?? '')}`.trim();
    case 'submit_validation_lead_outcome':
      return `submit_validation_lead_outcome: ${String(args['leadId'] ?? '')} ${String(args['outcome'] ?? '')}`;
    case 'submit_finding_disposition_outcome':
      return `submit_finding_disposition_outcome: ${String(args['findingId'] ?? '')} ${String(args['outcome'] ?? '')}`;
    case 'report_finalizer_preflight':
      return `report_finalizer_preflight: ${String(args['intendedMode'] ?? 'computed')}`;
    case 'prepare_report_context':
      return `prepare_report_context: ${String(args['detail'] ?? 'brief')}`;
    case 'finalize_run_artifacts':
      return `finalize_run_artifacts: ${String(args['mode'] ?? 'final')}`;
    case 'report_note':
      return `report_note${args['ntype'] ? ` [${args['ntype']}]` : ''}: ${String(args['title'] ?? '')}`;
    case 'wait_for_shell_job':
      return `wait_for_shell_job: ${String(args['jobId'] ?? '')}`;
    case 'file_read':
      return `file_read ${String(args['path'] ?? '')}`;
    case 'file_write':
      return `file_write ${String(args['path'] ?? '')}`;
    default:
      return toolName;
  }
}

function isErrorResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && 'error' in result;
}

function attachEnumerationAttemptReceipt(
  result: unknown,
  attempt: EnumerationServerAttemptRecordV1 | undefined,
): unknown {
  if (!attempt) {
    return result;
  }
  const receipt = {
    reservationFingerprint: attempt.reservationFingerprint,
    fingerprintsByTechnique: attempt.fingerprintsByTechnique,
    surfaceRef: attempt.surfaceRef,
    toolClass: attempt.toolClass,
    actionClass: attempt.actionClass,
    personaClass: attempt.personaClass,
    requestCount: attempt.requestCount,
    reservedAt: new Date(attempt.reservedAt).toISOString(),
  };
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return {
      ...(result as Record<string, unknown>),
      enumerationAttemptReceipt: receipt,
    };
  }
  return { data: result, enumerationAttemptReceipt: receipt };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown parse error');
}

function previewRawToolArgs(rawArgsJson: string): string {
  const normalized = rawArgsJson.replace(/\s+/g, ' ').trim();
  if (normalized.length <= TOOL_ARGS_PREVIEW_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, TOOL_ARGS_PREVIEW_LIMIT)}...`;
}

function buildInvalidToolArgsResult(toolName: string, rawArgsJson: string, error: unknown): Record<string, unknown> {
  const message = getErrorMessage(error);
  return {
    ok: false,
    success: false,
    error: `Invalid JSON arguments for ${toolName}. Correct the tool arguments and retry. ${message}`,
    errorCode: INVALID_TOOL_ARGS_ERROR_CODE,
    retryable: true,
    recoverable: true,
    toolName,
    rawArgsPreview: previewRawToolArgs(rawArgsJson),
  };
}

export class ToolsRegistry {
  private streamBroker: StreamBroker;
  private sessionStore: SessionStore;
  private sandboxManager?: SandboxAdapter;
  private checkpointManager?: CheckpointManager;
  private traceRecorder?: SessionTraceRecorder;
  private planRuntime: PlanRuntime;
  // SIMPLIFIED: Using SimpleApprovalHelper instead of complex ApprovalService
  private readonly approvalHelper: SimpleApprovalHelper;
  private readonly toolRegistry: ToolManifestRegistry;
  private readonly toolExecutionDb?: ToolExecutionPort;
  private ready: Promise<void>;
  private modules: Map<string, ToolModuleDefinition> = new Map();
  private manifests: Map<string, ToolManifest> = new Map();
  private isReady = false;
  private readonly config?: ResolvedConfig;
  private readonly runtimeHostCapabilities?: RuntimeHostCapabilities;

  private policyChecker: ToolPolicyChecker;
  private telemetry: ToolTelemetry;
  private readonly jsonRepair = new JsonRepairService();
  private readonly toolLifecycleHooks: ToolLifecycleHookRegistry;
  private workerDelegation?: WorkerDelegationService;

  constructor(
    streamBroker: StreamBroker,
    sessionStore: SessionStore,
    sandboxManager?: SandboxAdapter,
    checkpointManager?: CheckpointManager,
    traceRecorder?: SessionTraceRecorder,
    options?: {
      toolsDir: string;
      devWatch?: boolean;
      config?: ResolvedConfig;
      toolExecutionDb?: ToolExecutionPort;
      policyChecker?: ToolPolicyChecker;
      toolLifecycleHooks?: ToolLifecycleHookRegistry;
      workerDelegation?: WorkerDelegationService;
      runtimeHostCapabilities?: RuntimeHostCapabilities;
    },
  ) {
    const resolvedOptions = options ?? { toolsDir: '' };
    this.streamBroker = streamBroker;
    this.sessionStore = sessionStore;
    this.sandboxManager = sandboxManager;
    this.checkpointManager = checkpointManager;
    this.traceRecorder = traceRecorder;
    this.config = resolvedOptions.config;
    this.runtimeHostCapabilities = resolvedOptions.runtimeHostCapabilities;
    this.workerDelegation = resolvedOptions.workerDelegation;
    // SIMPLIFIED Dec 2025: Removed AutomationModePolicy coupling with approval
    // Using SimpleApprovalHelper instead of complex ApprovalService
    this.approvalHelper = new SimpleApprovalHelper(sessionStore, streamBroker);
    this.toolExecutionDb = resolvedOptions.toolExecutionDb;
    this.planRuntime = new PlanRuntime({
      sessionStore: this.sessionStore,
      streamBroker: this.streamBroker,
      snippetLimit: PROVENANCE_SNIPPET_LIMIT,
      traceRecorder: this.traceRecorder,
    });
    if (!resolvedOptions.toolsDir || resolvedOptions.toolsDir.trim().length === 0) {
      throw new Error('[ToolsRegistry] toolsDir is required (configure manifests.toolsDir).');
    }
    this.toolRegistry = new ToolManifestRegistry({
      directory: resolvedOptions.toolsDir,
      devWatch: resolvedOptions.devWatch ?? false,
      onUpdate: (modules) => this.reloadModules(modules),
    });

    this.policyChecker = resolvedOptions.policyChecker ?? new ToolPolicyChecker();
    this.toolLifecycleHooks = resolvedOptions.toolLifecycleHooks ?? new ToolLifecycleHookRegistry();
    this.telemetry = new ToolTelemetry();
    this.ready = this.toolRegistry
      .init()
      .then(() => {
        if (!this.isReady) {
          throw new Error('[ToolsRegistry] No tool manifests were loaded.');
        }
      })
      .catch((error) => {
        logger.error({ err: error }, '[ToolsRegistry] Failed to initialize tool manifests');
        throw error;
      });
  }

  async listManifests(): Promise<ToolManifest[]> {
    await this.ensureReady();
    return Array.from(this.manifests.values()).map((manifest) => {
      const contract = toolContractRegistry.get(manifest.id);
      if (!contract) {
        return manifest;
      }
      return {
        ...manifest,
        summary: contract.description,
        argsSchema: contract.schema,
      };
    });
  }

  async getManifest(id: string): Promise<ToolManifest | undefined> {
    await this.ensureReady();
    const manifest = this.manifests.get(id);
    if (!manifest) {
      return undefined;
    }
    const contract = toolContractRegistry.get(manifest.id);
    if (!contract) {
      return manifest;
    }
    return {
      ...manifest,
      summary: contract.description,
      argsSchema: contract.schema,
    };
  }

  async listCatalogTools(): Promise<Array<{ manifest: ToolManifest; meta: ToolMeta; sourceFile?: string }>> {
    await this.ensureReady();
    return Array.from(this.modules.values())
      .filter((module, index, modules) =>
        modules.findIndex((candidate) => candidate.manifest.id === module.manifest.id) === index,
      )
      .map((module) => {
        const contract = toolContractRegistry.get(module.manifest.id);
        const manifest = contract
          ? {
              ...module.manifest,
              summary: contract.description,
              argsSchema: contract.schema,
            }
          : module.manifest;
        return {
          manifest,
          meta: module.meta,
          sourceFile: module.sourceFile,
        };
      })
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  getToolProgressKind(id: string): ToolMeta['progressKind'] | undefined {
    const module = this.modules.get(id);
    return module?.meta.progressKind ?? this.manifests.get(id)?.meta.progressKind;
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
    if (!this.isReady) {
      throw new Error('Tools registry failed to initialize');
    }
  }

  private reloadModules(modules: ToolModuleDefinition[]): void {
    this.modules.clear();
    this.manifests.clear();
    for (const module of modules) {
      const key = module.manifest.id;
      this.modules.set(key, module);
      if (module.meta?.name && module.meta.name !== key) {
        this.modules.set(module.meta.name, module);
      }
      this.manifests.set(key, module.manifest);
    }
    this.isReady = true;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private async getToolModule(name: string): Promise<ToolModuleDefinition | undefined> {
    await this.ensureReady();
    if (this.modules.has(name)) {
      return this.modules.get(name);
    }
    const fallback = name.replace(/\./g, '_');
    return this.modules.get(fallback);
  }

  private preparePlanStepContext(sessionId: string, toolName: string, args: unknown): PlanItem | undefined {
    const session = this.sessionStore.get(sessionId);
    if (!session || session.plan.length === 0) {
      return undefined;
    }

    const explicit = this.extractExplicitStepId(args, session);
    if (explicit) {
      // downstream caller can await if needed
      return this.activatePlanStep(sessionId, explicit) as unknown as PlanItem;
    }

    // DISABLED Dec 2025: Inference creates unpredictable UX ("why did that step get marked?")
    // Users should use plan_set_step_status tool explicitly for deterministic behavior.
    // Codex/Claude feel seamless because state changes are explicit and visible.
    // const inferred = this.planInferenceService.inferPlanStep(session, toolName, args);
    // if (inferred) {
    //   return this.activatePlanStep(sessionId, inferred) as unknown as PlanItem;
    // }

    if (
      session.currentPlanStepId &&
      session.plan.some((step) => step.id === session.currentPlanStepId && step.status === 'running')
    ) {
      const current = session.plan.find((step) => step.id === session.currentPlanStepId);
      if (current) {
        return current;
      }
    }

    return this.ensureActivePlanStepSync(sessionId);
  }

  private extractExplicitStepId(args: unknown, session: SessionState): PlanItem | undefined {
    if (!args || typeof args !== 'object') {
      return undefined;
    }
    const candidate =
      (args as Record<string, unknown>).__planStepId ??
      (args as Record<string, unknown>).planStepId ??
      (args as Record<string, unknown>).stepId;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return undefined;
    }
    const normalized = candidate.trim();
    return session.plan.find((step) => step.id === normalized);
  }

  private async activatePlanStep(sessionId: string, step: PlanItem): Promise<PlanItem> {
    const session = this.sessionStore.get(sessionId);
    if (!session) {
      return step;
    }
    const alreadyCurrent =
      session.currentPlanStepId === step.id && step.status === 'running';
    if (alreadyCurrent) {
      return step;
    }
    const suppressTelemetry =
      step.status === 'running' && session.currentPlanStepId === step.id;
    const updated = await this.planRuntime.transitionPlanStep(
      sessionId,
      step.id,
      'running',
      {},
      { suppressTelemetry }
    );
    return updated ?? step;
  }

  private async transitionPlanStep(
    sessionId: string,
    stepId: string,
    nextStatus?: StepStatus,
    fields: Partial<PlanItem> = {},
    options: { suppressTelemetry?: boolean } = {}
  ): Promise<PlanItem | undefined> {
    return this.planRuntime.transitionPlanStep(sessionId, stepId, nextStatus, fields, options);
  }

  private ensureActivePlanStepSync(sessionId: string): PlanItem | undefined {
    // Best-effort sync read; call sites that need async path should call planRuntime directly.
    const session = this.sessionStore.get(sessionId);
    if (!session || session.plan.length === 0) {
      return undefined;
    }
    const running = session.plan.find((step) => step.status === 'running');
    if (running) {
      return running;
    }
    const resumableBlocked = session.plan.find(
      (step) => step.status === 'blocked' && isResumablePlanBlockReason(step.blockedReason)
    );
    if (resumableBlocked) {
      return resumableBlocked;
    }
    return session.plan.find((step) => step.status === 'pending');
  }

  private resetProvenanceBuffer(sessionId: string): void {
    this.planRuntime.resetProvenanceBuffer(sessionId);
  }

  private clearProvenanceBuffer(sessionId: string): void {
    this.planRuntime.clearProvenanceBuffer(sessionId);
  }

  private extractPlanStepIdArg(args: unknown): string | undefined {
    if (!args || typeof args !== 'object') {
      return undefined;
    }
    const candidate =
      (args as Record<string, unknown>).__planStepId ??
      (args as Record<string, unknown>).planStepId ??
      (args as Record<string, unknown>).stepId;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      return undefined;
    }
    return candidate.trim();
  }

  private getWorkerPlanBindingState(session: SessionState | undefined, turnId: string): WorkerPlanBindingState | null {
    const namespace = session?.flags?.[WORKER_PLAN_BINDING_FLAG_NAMESPACE];
    if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
      return null;
    }

    const record = namespace as Record<string, unknown>;
    const storedTurnId = typeof record[WORKER_PLAN_BINDING_FLAG_TURN_ID] === 'string'
      ? (record[WORKER_PLAN_BINDING_FLAG_TURN_ID] as string).trim()
      : '';
    if (!storedTurnId || storedTurnId !== turnId) {
      return null;
    }

    const pendingStepIds = Array.isArray(record[WORKER_PLAN_BINDING_FLAG_STEP_IDS])
      ? Array.from(
        new Set(
          (record[WORKER_PLAN_BINDING_FLAG_STEP_IDS] as unknown[])
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
        ),
      )
      : [];

    return {
      turnId: storedTurnId,
      pendingStepIds,
    };
  }

  private async persistWorkerPlanBindingState(
    sessionId: string,
    state: WorkerPlanBindingState | null,
  ): Promise<void> {
    if (!state || state.pendingStepIds.length === 0) {
      await this.sessionStore.mergeFlagNamespaceAsync(sessionId, WORKER_PLAN_BINDING_FLAG_NAMESPACE, {
        [WORKER_PLAN_BINDING_FLAG_TURN_ID]: undefined,
        [WORKER_PLAN_BINDING_FLAG_STEP_IDS]: undefined,
      });
      return;
    }

    await this.sessionStore.mergeFlagNamespaceAsync(sessionId, WORKER_PLAN_BINDING_FLAG_NAMESPACE, {
      [WORKER_PLAN_BINDING_FLAG_TURN_ID]: state.turnId,
      [WORKER_PLAN_BINDING_FLAG_STEP_IDS]: state.pendingStepIds,
    });
  }

  private async enqueueWorkerPlanBindingStep(
    sessionId: string,
    turnId: string,
    stepId: string,
  ): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    const current = this.getWorkerPlanBindingState(session, turnId);
    const pendingStepIds = current ? [...current.pendingStepIds] : [];
    if (!pendingStepIds.includes(stepId)) {
      pendingStepIds.push(stepId);
    }
    await this.persistWorkerPlanBindingState(sessionId, {
      turnId,
      pendingStepIds,
    });
  }

  private async removeWorkerPlanBindingStep(
    sessionId: string,
    turnId: string,
    stepId: string,
  ): Promise<void> {
    const session = this.sessionStore.get(sessionId);
    const current = this.getWorkerPlanBindingState(session, turnId);
    if (!current) {
      return;
    }

    const pendingStepIds = current.pendingStepIds.filter((candidate) => candidate !== stepId);
    await this.persistWorkerPlanBindingState(
      sessionId,
      pendingStepIds.length > 0
        ? {
          turnId,
          pendingStepIds,
        }
        : null,
    );
  }

  private maybeInjectWorkerPlanBinding(
    session: SessionState | undefined,
    turnId: string,
    toolName: string,
    args: ToolArgs,
  ): { args: ToolArgs; injectedPlanStepId?: string } {
    if (toolName !== 'spawn_worker') {
      return { args };
    }

    if (this.extractPlanStepIdArg(args)) {
      return { args };
    }

    const bindingState = this.getWorkerPlanBindingState(session, turnId);
    const injectedPlanStepId = bindingState?.pendingStepIds[0];
    if (!injectedPlanStepId) {
      return { args };
    }

    return {
      args: {
        ...args,
        __planStepId: injectedPlanStepId,
      },
      injectedPlanStepId,
    };
  }

  private toolResultSucceeded(result: unknown): boolean {
    if (!result || typeof result !== 'object') {
      return true;
    }

    if ('success' in (result as Record<string, unknown>)) {
      return (result as Record<string, unknown>).success !== false;
    }
    if ('error' in (result as Record<string, unknown>)) {
      return false;
    }
    return true;
  }

  private async reconcileWorkerPlanBindingSuccess(
    sessionId: string,
    turnId: string,
    toolName: string,
    args: ToolArgs,
    result: unknown,
  ): Promise<void> {
    if (!this.toolResultSucceeded(result)) {
      return;
    }

    if (toolName === 'plan_set_step_status') {
      const stepId = this.extractPlanStepIdArg(args);
      const status = typeof (args as Record<string, unknown>).status === 'string'
        ? ((args as Record<string, unknown>).status as string).trim().toLowerCase()
        : '';
      if (!stepId || !status) {
        return;
      }

      if (status === 'running') {
        await this.enqueueWorkerPlanBindingStep(sessionId, turnId, stepId);
        return;
      }

      if (['pending', 'completed', 'blocked', 'error'].includes(status)) {
        await this.removeWorkerPlanBindingStep(sessionId, turnId, stepId);
      }
      return;
    }

    if (toolName === 'spawn_worker') {
      const stepId = this.extractPlanStepIdArg(args);
      if (stepId) {
        await this.removeWorkerPlanBindingStep(sessionId, turnId, stepId);
      }
    }
  }

  private finalizePlanProvenance(
    sessionId: string,
    tool: string,
    result: unknown
  ): void {
    this.planRuntime.finalizePlanProvenance(sessionId, tool, result);
  }

  private handleToolFailure(sessionId: string, error: unknown): void {
    this.planRuntime.handleToolFailure(sessionId, error);
  }

  private buildApprovalPreview(
    descriptor: ToolUseDescriptor,
    args: ToolArgs,
  ): ApprovalPreview | undefined {
    const preview: ApprovalPreview = {};
    if (descriptor.command) {
      preview.cmd = descriptor.command;
    }
    if (descriptor.paths[0]) {
      preview.path = descriptor.paths[0];
    }

    const diffCandidate =
      typeof args.diff === 'string'
        ? args.diff
        : typeof args.patch === 'string'
          ? args.patch
          : undefined;
    if (typeof diffCandidate === 'string' && diffCandidate.trim().length > 0) {
      preview.diff = diffCandidate.slice(0, 4000);
    }

    const risk = Array.from(new Set(descriptor.actions.map((action) => action.trim()).filter((action) => action.length > 0)));
    if (risk.length > 0) {
      preview.risk = risk;
    }

    return Object.keys(preview).length > 0 ? preview : undefined;
  }

  private hasGrantedApprovalResume(
    session: SessionState | undefined,
    toolName: string,
    toolCallId?: string,
  ): boolean {
    const approvalResume = session?.flags?.approval_resume;
    if (!approvalResume || typeof approvalResume !== 'object' || Array.isArray(approvalResume)) {
      return false;
    }
    const approvalResumeRecord = approvalResume as Record<string, unknown>;

    const approvedTool = typeof approvalResumeRecord.tool === 'string' ? approvalResumeRecord.tool.trim() : '';
    const approvedActionId = typeof approvalResumeRecord.actionId === 'string' ? approvalResumeRecord.actionId.trim() : '';
    const approvedToolCallId = typeof approvalResumeRecord.toolCallId === 'string' ? approvalResumeRecord.toolCallId.trim() : '';
    if (!approvedTool || approvedTool !== toolName) {
      return false;
    }
    if (!toolCallId) {
      return true;
    }
    return toolCallId === approvedToolCallId || toolCallId === approvedActionId;
  }

  private cloneFlags(flags?: SessionFlags): SessionFlags {
    if (!flags) {
      return {};
    }
    return JSON.parse(JSON.stringify(flags));
  }

  private buildRuntimeContext(params: {
    session: SessionState;
    sessionId: string;
    toolName: string;
    args: ToolArgs;
    toolCallId?: string;
    turnNumber?: number;
    budget?: ToolBudgetSnapshot;
    flagsSnapshot: SessionFlags;
    abortSignal?: AbortSignal;
    executeModelCall?: ToolExecutionOptions['executeModelCall'];
  }): RuntimeToolContext {
    if (!this.sandboxManager) {
      throw new Error('Sandbox manager is not configured');
    }

    const sessionPolicy = params.session.toolPolicy;
    const denyPatterns = (sessionPolicy?.deny ?? []).map((pattern) => {
      const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`, 'i');
    });

    return {
      sessionId: params.sessionId,
      toolCallId: params.toolCallId,
      turnNumber: params.turnNumber,
      workspaceDir: params.session.workspaceDir,
      sandbox: this.sandboxManager,
      sessionStore: this.sessionStore,
      streamBroker: this.streamBroker,
      trace: this.traceRecorder,
      approvals: {
        require: async ({ preview: _preview }: { tool: string; preview?: Record<string, unknown> }) => {
          const decision = await this.approvalHelper.requestApproval(
            params.session,
            params.sessionId,
            params.toolName,
            params.args,
            { toolCallId: params.toolCallId, preview: _preview },
          );
          if (decision && decision.status === 'denied') {
            throw new ApprovalDeniedError(decision.reason, params.toolName);
          }
        },
      },
      checkpoints: this.checkpointManager,
      guards: {
        pathGuard: new PathGuard(params.session.workspaceDir),
        cmdGuard: new CmdGuard(),
      },
      scopeId: params.session.scopeId,
      policies: {
        requireApproval: this.approvalHelper.shouldAwaitApproval(params.session),
        allowlist: sessionPolicy?.allow,
        denyPatterns,
        maxStdoutBytes: this.config?.trace.stdoutChunkSize ?? 65_536,
        timeoutMs: this.config?.runtime.shellTimeoutMs ?? 120_000,
      },
      flags: params.flagsSnapshot,
      planRuntime: this.planRuntime,
      ...(this.workerDelegation ? {
        workers: {
          spawnWorker: (input) => this.workerDelegation!.spawnWorker(input),
          continueWorker: (input) => this.workerDelegation!.continueWorker(input),
          stopWorker: (input) => this.workerDelegation!.stopWorker(input),
          waitForWorker: (input) => this.workerDelegation!.waitForWorker(input),
          syncWorkerTasks: (parentSessionId) => this.workerDelegation!.syncWorkerTasks(parentSessionId),
        },
      } : {}),
      budget: params.budget,
      abortSignal: params.abortSignal ?? new AbortController().signal,
      executeModelCall: params.executeModelCall,
      config: this.config,
    };
  }

  private adaptRuntimeResult(result: RuntimeToolResult | unknown): unknown {
    if (!result || typeof result !== 'object') {
      return result;
    }

    if ('ok' in result || 'data' in result) {
      const raw = result as RuntimeToolResult & Record<string, unknown>;
      let payload: unknown = raw.data;
      if (payload === undefined || payload === null) {
        payload = {};
      }
      if (typeof payload === 'object' && payload !== null) {
        payload = { ...(payload as Record<string, unknown>) };
      }
      if (raw.ok === false) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          if (!('success' in payload)) {
            (payload as Record<string, unknown>).success = false;
          }
          if (raw.message && !('error' in payload)) {
            (payload as Record<string, unknown>).error = raw.message;
          }
        } else {
          payload = { success: false, value: payload, error: raw.message };
        }
      }
      if (raw.control && typeof raw.control === 'object' && raw.control !== null) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          (payload as Record<string, unknown>).control = raw.control;
        } else {
          payload = { value: payload, control: raw.control };
        }
      }
      return payload;
    }

    return result;
  }

  private buildExecutionReceipt(
    toolName: string,
    toolCallId: string | undefined,
    result: unknown,
    runtimeOutcome?: ToolExecutionOutcome,
    context?: {
      modelRequestId?: string;
      pipeline?: ToolExecutionPipelineContext;
    },
  ): ToolExecutionReceiptV1 {
    let outcome = runtimeOutcome;
    if (!outcome) {
      const payload = result && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      const control = payload?.control && typeof payload.control === 'object'
        ? payload.control as Record<string, unknown>
        : undefined;
      if (payload?.aborted === true) {
        outcome = 'interrupted';
      } else if (payload?.approvalRequired === true || control?.kind === 'awaiting_approval') {
        outcome = 'awaiting_approval';
      } else if (payload?.skipped === true) {
        outcome = 'skipped';
      } else if (payload?.forbidden === true || payload?.denied === true) {
        outcome = 'blocked';
      } else if (payload?.success === false || payload?.ok === false || typeof payload?.error === 'string') {
        outcome = 'failed';
      } else {
        outcome = 'succeeded';
      }
    }

    return {
      schema: 'tool-execution-receipt/v1',
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      ...(context?.modelRequestId ? { modelRequestId: context.modelRequestId } : {}),
      outcome,
      ...(context?.pipeline ? {
        pipeline: {
          schema: context.pipeline.schema,
          completedStages: [...context.pipeline.completedStages],
        },
      } : {}),
    };
  }

  private parseRawArgs(rawArgsJson: string | undefined): ToolArgs {
    if (typeof rawArgsJson !== 'string') {
      return {};
    }

    const parsed = this.jsonRepair.parse(rawArgsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ToolArgs;
    }
    return {};
  }

  private async executePreparedTool(params: {
    runtimeTool: ToolModuleDefinition;
    toolName: string;
    args: ToolArgs;
    sessionId: string;
    session?: SessionState;
    isPlanManagementTool: boolean;
    toolCallId?: string;
    turnNumber?: number;
    budget?: ToolBudgetSnapshot;
    abortSignal?: AbortSignal;
    executeModelCall?: ToolExecutionOptions['executeModelCall'];
    captureRuntimeOutcome?: (outcome: ToolExecutionOutcome) => void;
  }): Promise<unknown> {
    const session = params.session ?? this.sessionStore.get(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const flagsSnapshot = this.cloneFlags(session.flags);
    for (const namespace of Object.keys(flagsSnapshot)) {
      Object.freeze(flagsSnapshot[namespace]);
    }
    Object.freeze(flagsSnapshot);

    const runtimeContext = this.buildRuntimeContext({
      session,
      sessionId: params.sessionId,
      toolName: params.toolName,
      args: params.args,
      toolCallId: params.toolCallId,
      turnNumber: params.turnNumber,
      budget: params.budget,
      flagsSnapshot,
      abortSignal: params.abortSignal,
      executeModelCall: params.executeModelCall,
    });

    if (!params.isPlanManagementTool) {
      const planStep = this.preparePlanStepContext(params.sessionId, params.toolName, params.args);
      if (planStep) {
        this.resetProvenanceBuffer(params.sessionId);
      } else {
        this.clearProvenanceBuffer(params.sessionId);
      }
    } else {
      this.clearProvenanceBuffer(params.sessionId);
    }

    const rawResult = await params.runtimeTool.run(params.args, runtimeContext);
    params.captureRuntimeOutcome?.(rawResult.ok ? 'succeeded' : 'failed');
    const adaptedResult = this.adaptRuntimeResult(rawResult);

    if (!params.isPlanManagementTool) {
      this.finalizePlanProvenance(params.sessionId, params.toolName, adaptedResult);
    }

    return adaptedResult;
  }

  private async executeWithRetry(params: {
    runtimeTool: ToolModuleDefinition;
    toolName: string;
    args: ToolArgs;
    sessionId: string;
    session?: SessionState;
    isPlanManagementTool: boolean;
    toolCallId?: string;
    turnNumber?: number;
    budget?: ToolBudgetSnapshot;
    abortSignal?: AbortSignal;
    executeModelCall?: ToolExecutionOptions['executeModelCall'];
    captureRuntimeOutcome?: (outcome: ToolExecutionOutcome) => void;
  }): Promise<unknown> {
    try {
      return await this.executePreparedTool(params);
    } catch (error) {
      if (params.abortSignal?.aborted) {
        throw error;
      }
      await this.delay(1000);
      return this.executePreparedTool(params);
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getLifecycleHooks(): ToolLifecycleHookRegistry {
    return this.toolLifecycleHooks;
  }

  setWorkerDelegationService(workerDelegation?: WorkerDelegationService): void {
    this.workerDelegation = workerDelegation;
  }

  private markToolBlocked(
    sessionId: string,
    message: string,
    options: { isPlanManagementTool: boolean; session?: SessionState },
  ): void {
    if (options.isPlanManagementTool) {
      return;
    }

    const session = options.session ?? this.sessionStore.get(sessionId);
    const activeStepId = session?.currentPlanStepId;
    if (activeStepId) {
      this.transitionPlanStep(sessionId, activeStepId, 'blocked', {
        blockedReason: message,
      });
    }
    this.clearProvenanceBuffer(sessionId);
  }

  private async recordPermissionDecision(
    sessionId: string,
    turn: number,
    decision: ToolPermissionDecision,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.traceRecorder || decision.behavior === 'allow') {
      return;
    }

    await this.traceRecorder.write(sessionId, turn, {
      event: 'tool.permission_decision',
      severity: 'warn',
      payload: {
        toolName: decision.descriptor.toolName,
        behavior: decision.behavior,
        source: decision.source,
        reason: decision.reason,
        toolCallId,
        category: decision.descriptor.category,
        actions: decision.descriptor.actions,
        paths: decision.descriptor.paths,
        hosts: decision.descriptor.hosts,
        command: decision.descriptor.command,
      },
      note: `${decision.descriptor.toolName}: permission ${decision.behavior}`,
    });
  }

  private async recordHookBlock(
    sessionId: string,
    turn: number,
    toolName: string,
    reason: string,
    toolCallId?: string,
  ): Promise<void> {
    if (!this.traceRecorder) {
      return;
    }

    await this.traceRecorder.write(sessionId, turn, {
      event: 'tool.hook_blocked',
      severity: 'warn',
      payload: {
        toolName,
        reason,
        toolCallId,
      },
      note: `${toolName}: hook blocked execution`,
    });
  }

  private async reserveAttackTargetRequests(
    session: SessionState | undefined,
    toolName: string,
    args: ToolArgs,
    budget: ToolBudgetSnapshot | undefined,
    turn: number,
    toolCallId?: string,
  ): Promise<AttackRequestReservation | { blockedReason: string }> {
    if (
      !session ||
      session.coordination?.role !== 'worker' ||
      session.coordination.workerType !== 'attack_worker'
    ) {
      return { requestCost: 0, requestConcurrency: 0 };
    }

    const reservation = await this.sessionStore.updateSessionAsync(session.id, (current): {
      decision: AttackRuntimeGuardDecision;
      parentSessionId?: string;
      parentTaskId?: string;
    } => {
      const decision = assessAttackWorkerToolUse(current, toolName, args);
      if (!decision.targetCapable || decision.blockedReason) {
        return { decision };
      }
      const liveAdmission = getControlledExploitationAdmissionState(current.flags);
      if (!liveAdmission.allowed) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetCapable: true,
            blockedReason: `attack_worker live_kill_switch: ${liveAdmission.reason}`,
          },
        };
      }
      const securityops =
        current.flags?.securityops &&
        typeof current.flags.securityops === 'object' &&
        !Array.isArray(current.flags.securityops)
          ? current.flags.securityops as Record<string, unknown>
          : {};
      const runId = typeof securityops.runId === 'string' ? securityops.runId : null;
      if (workCancellationRegistry.isCancelled(current.id, runId)) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetCapable: true,
            blockedReason: 'attack_worker run_cancelled',
          },
        };
      }
      if (
        securityops.activePhaseKey !== 'exploitation' ||
        securityops.exploitationImpactTolerance !== 'full' ||
        securityops.exploitationRunTrigger !== 'manual' ||
        securityops.workflowDiscipline !== 'pentest'
      ) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetCapable: true,
            blockedReason: 'attack_worker phase_or_roe_identity_mismatch',
          },
        };
      }
      const parentSessionId = current.coordination?.parentSessionId;
      const parentTaskId = current.coordination?.parentTaskId;
      const parent = parentSessionId ? this.sessionStore.get(parentSessionId) : undefined;
      const parentSecurityops =
        parent?.flags?.securityops &&
        typeof parent.flags.securityops === 'object' &&
        !Array.isArray(parent.flags.securityops)
          ? parent.flags.securityops as Record<string, unknown>
          : {};
      const parentTask = parent?.workerTasks?.find((task) => task.taskId === parentTaskId);
      if (
        !parent ||
        parentSecurityops.activePhaseKey !== 'exploitation' ||
        parentSecurityops.activePhaseId !== securityops.activePhaseId ||
        parentTask?.workerType !== 'attack_worker' ||
        parentTask.status !== 'running'
      ) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetCapable: true,
            blockedReason: 'attack_worker parent_phase_identity_mismatch',
          },
        };
      }
      if (
        budget?.remainingToolCalls !== undefined &&
        budget.remainingToolCalls <= 0
      ) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetCapable: true,
            blockedReason: 'attack_worker tool_budget_exhausted',
          },
        };
      }
      if (!current.coordination) {
        return {
          decision: {
            requestCost: 0,
            requestConcurrency: 0,
            targetCapable: true,
            blockedReason: 'attack_worker coordination_missing',
          },
        };
      }
      current.coordination.targetRequestsUsed =
        (current.coordination.targetRequestsUsed ?? 0) + decision.requestCost;
      current.coordination.activeTargetRequests =
        (current.coordination.activeTargetRequests ?? 0) + decision.requestConcurrency;
      return { decision, parentSessionId, parentTaskId };
    });

    const decision = reservation?.decision ?? {
      requestCost: 0,
      requestConcurrency: 0,
      targetCapable: true,
      blockedReason: 'attack_worker session_missing',
    };
    const liveSession = this.sessionStore.get(session.id) ?? session;
    if (decision.blockedReason) {
      liveSession.blockedReason = decision.blockedReason;
      const parentSessionId = liveSession.coordination?.parentSessionId;
      const parentTaskId = liveSession.coordination?.parentTaskId;
      if (parentSessionId && parentTaskId) {
        await this.sessionStore.updateSessionAsync(parentSessionId, (parent) => {
          const task = parent.workerTasks?.find((candidate) => candidate.taskId === parentTaskId);
          if (task) {
            task.status = 'failed';
            task.lastError = decision.blockedReason;
            task.lastStatusReason = decision.blockedReason;
            task.lastUpdatedAt = Date.now();
            task.completedAt = Date.now();
          }
        });
      }
      if (this.traceRecorder) {
        await this.traceRecorder.write(session.id, turn, {
          event: 'attack_worker.request.rejected',
          severity: 'warn',
          payload: {
            toolName,
            toolCallId,
            reason: decision.blockedReason,
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetRequestsUsed: liveSession.coordination?.targetRequestsUsed ?? 0,
            maxTargetRequests: liveSession.coordination?.maxTargetRequests,
          },
          note: `${toolName}: ${decision.blockedReason}`,
        });
      }
      return { blockedReason: decision.blockedReason };
    }
    const parentSessionId = liveSession.coordination?.parentSessionId;
    const parentTaskId = liveSession.coordination?.parentTaskId;
    if (parentSessionId && parentTaskId) {
      await this.sessionStore.updateSessionAsync(parentSessionId, (parent) => {
        const task = parent.workerTasks?.find((candidate) => candidate.taskId === parentTaskId);
        if (task) {
          task.targetRequestsUsed = liveSession.coordination?.targetRequestsUsed ?? 0;
          task.lastUpdatedAt = Date.now();
        }
      });
    }
    if (this.traceRecorder && decision.targetCapable) {
      await this.traceRecorder.write(session.id, turn, {
        event: 'attack_worker.request.reserved',
        severity: 'debug',
        payload: {
          toolName,
          toolCallId,
          requestCost: decision.requestCost,
          requestConcurrency: decision.requestConcurrency,
          targetRequestsUsed: liveSession.coordination?.targetRequestsUsed,
          maxTargetRequests: liveSession.coordination?.maxTargetRequests,
        },
        note: `${toolName}: admitted controlled exploitation target call`,
      });
    }
    return {
      requestCost: decision.requestCost,
      requestConcurrency: decision.requestConcurrency,
    };
  }

  private async releaseAttackTargetRequests(
    sessionId: string,
    reservation: AttackRequestReservation,
  ): Promise<void> {
    if (reservation.requestConcurrency <= 0) return;
    await this.sessionStore.updateSessionAsync(sessionId, (session) => {
      if (
        session.coordination?.role === 'worker' &&
        session.coordination.workerType === 'attack_worker'
      ) {
        session.coordination.activeTargetRequests = Math.max(
          0,
          (session.coordination.activeTargetRequests ?? 0) - reservation.requestConcurrency,
        );
      }
    });
  }

  private async reserveEnumerationTargetRequests(
    session: SessionState | undefined,
    toolName: string,
    args: ToolArgs,
    turn: number,
    toolCallId?: string,
  ): Promise<EnumerationRequestReservation | { blockedReason: string }> {
    if (
      !session ||
      session.coordination?.role !== 'worker' ||
      session.coordination.workerType !== 'enumeration_worker'
    ) {
      return {
        requestCost: 0,
        requestConcurrency: 0,
      };
    }

    const reservation = await this.sessionStore.updateSessionAsync(session.id, (current): {
      decision: EnumerationRuntimeGuardDecision;
      attempt?: EnumerationServerAttemptRecordV1;
    } => {
      const admission = getEnumerationWorkerAdmissionState(current.flags);
      if (!admission.allowed) {
        return {
          decision: {
            requestCost: 0,
            requestConcurrency: 0,
            blockedReason: `enumeration_worker live_kill_switch: ${admission.reason}`,
          },
        };
      }
      const decision = assessEnumerationWorkerToolUse(current, toolName, args);
      if (decision.blockedReason || decision.requestCost === 0) {
        return { decision };
      }
      if (!current.coordination) {
        return {
          decision: {
            requestCost: 0,
            requestConcurrency: 0,
            blockedReason: 'enumeration_worker coordination_missing',
          },
        };
      }
      const missionEnvelope = current.task?.vars?.mission;
      const mission =
        typeof missionEnvelope === 'object' && missionEnvelope !== null
          ? (missionEnvelope as { enumeration?: EnumerationMissionV1 }).enumeration
          : undefined;
      if (!mission) {
        return {
          decision: {
            requestCost: 0,
            requestConcurrency: 0,
            blockedReason: 'enumeration_worker mission_missing',
          },
        };
      }
      const attempt = buildEnumerationAttemptReservation(
        mission,
        toolName,
        args,
        decision.requestCost,
        Date.now(),
      );
      const reservations = current.coordination.enumerationAttemptReservations ?? {};
      const completed = current.coordination.enumerationAttempts ?? [];
      if (
        reservations[attempt.reservationFingerprint] ||
        completed.some(
          (candidate) => candidate.reservationFingerprint === attempt.reservationFingerprint,
        )
      ) {
        return {
          decision: {
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            blockedReason: 'enumeration_worker attempt_duplicate',
          },
        };
      }
      reservations[attempt.reservationFingerprint] = attempt;
      current.coordination.enumerationAttemptReservations = reservations;
      current.coordination.targetRequestsUsed =
        (current.coordination.targetRequestsUsed ?? 0) + decision.requestCost;
      current.coordination.activeTargetRequests =
        (current.coordination.activeTargetRequests ?? 0) + decision.requestConcurrency;
      return { decision, attempt };
    });

    const decision = reservation?.decision ?? {
      requestCost: 0,
      requestConcurrency: 0,
      blockedReason: 'enumeration_worker session_missing',
    };
    const liveSession = this.sessionStore.get(session.id) ?? session;
    if (decision.blockedReason) {
      enumerationWorkerTargetRequestTotal.inc({
        decision: 'rejected',
        reason: decision.blockedReason.split(':', 1)[0] ?? 'unknown',
      }, Math.max(1, decision.requestCost));
      if (decision.blockedReason === 'enumeration_worker attempt_duplicate') {
        enumerationWorkerAttemptTotal.inc({ decision: 'duplicate', status: 'rejected' });
      }
      if (this.traceRecorder) {
        await this.traceRecorder.write(session.id, turn, {
          event: decision.blockedReason === 'enumeration_worker attempt_duplicate'
            ? 'enumeration_worker.attempt.duplicate'
            : 'enumeration_worker.request.rejected',
          severity: 'warn',
          payload: {
            toolName,
            toolCallId,
            reason: decision.blockedReason,
            requestCost: decision.requestCost,
            requestConcurrency: decision.requestConcurrency,
            targetRequestsUsed: liveSession.coordination?.targetRequestsUsed ?? 0,
            maxTargetRequests: liveSession.coordination?.maxTargetRequests,
          },
          note: `${toolName}: ${decision.blockedReason}`,
        });
      }
      return { blockedReason: decision.blockedReason };
    }
    if (decision.requestCost === 0) {
      return { requestCost: 0, requestConcurrency: 0 };
    }
    enumerationWorkerTargetRequestTotal.inc(
      { decision: 'reserved', reason: 'allowed' },
      decision.requestCost,
    );
    enumerationWorkerAttemptTotal.inc({ decision: 'reserved', status: 'active' });

    const parentSessionId = liveSession.coordination?.parentSessionId;
    const parentTaskId = liveSession.coordination?.parentTaskId;
    if (parentSessionId && parentTaskId) {
      await this.sessionStore.updateSessionAsync(parentSessionId, (parent) => {
        const task = parent.workerTasks?.find((candidate) => candidate.taskId === parentTaskId);
        if (task) {
          task.targetRequestsUsed = liveSession.coordination?.targetRequestsUsed ?? 0;
          task.lastUpdatedAt = Date.now();
        }
      });
    }
    if (this.traceRecorder) {
      await this.traceRecorder.write(session.id, turn, {
        event: 'enumeration_worker.request.reserved',
        severity: 'debug',
        payload: {
          toolName,
          toolCallId,
          requestCost: decision.requestCost,
          requestConcurrency: decision.requestConcurrency,
          attemptFingerprint: reservation?.attempt?.reservationFingerprint,
          targetRequestsUsed: liveSession.coordination?.targetRequestsUsed,
          maxTargetRequests: liveSession.coordination?.maxTargetRequests,
        },
        note: `${toolName}: reserved ${decision.requestCost} target request(s)`,
      });
    }
    return {
      requestCost: decision.requestCost,
      requestConcurrency: decision.requestConcurrency,
      attempt: reservation?.attempt,
    };
  }

  private async releaseEnumerationTargetRequests(
    sessionId: string,
    reservation: EnumerationRequestReservation,
    status: 'completed' | 'failed',
  ): Promise<void> {
    if (reservation.requestConcurrency <= 0 && !reservation.attempt) {
      return;
    }
    const completion = await this.sessionStore.updateSessionAsync(sessionId, (session): {
      parentSessionId?: string;
      parentTaskId?: string;
      attempt?: EnumerationServerAttemptRecordV1;
      turn?: number;
    } => {
      if (
        session.coordination?.role !== 'worker' ||
        session.coordination.workerType !== 'enumeration_worker'
      ) {
        return {};
      }
      session.coordination.activeTargetRequests = Math.max(
        0,
        (session.coordination.activeTargetRequests ?? 0) - reservation.requestConcurrency,
      );
      if (!reservation.attempt) {
        return {
          parentSessionId: session.coordination.parentSessionId,
          parentTaskId: session.coordination.parentTaskId,
          turn: session.turn,
        };
      }
      const completedAttempt: EnumerationServerAttemptRecordV1 = {
        ...reservation.attempt,
        completedAt: Date.now(),
        status,
      };
      if (session.coordination.enumerationAttemptReservations) {
        delete session.coordination.enumerationAttemptReservations[
          reservation.attempt.reservationFingerprint
        ];
      }
      const attempts = session.coordination.enumerationAttempts ?? [];
      if (!attempts.some(
        (attempt) =>
          attempt.reservationFingerprint === completedAttempt.reservationFingerprint,
      )) {
        attempts.push(completedAttempt);
      }
      session.coordination.enumerationAttempts = attempts;
      return {
        parentSessionId: session.coordination.parentSessionId,
        parentTaskId: session.coordination.parentTaskId,
        attempt: completedAttempt,
        turn: session.turn,
      };
    });
    if (!completion?.attempt) {
      return;
    }
    enumerationWorkerAttemptTotal.inc({ decision: 'completed', status });
    if (this.traceRecorder) {
      await this.traceRecorder.write(sessionId, completion.turn ?? 0, {
        event: 'enumeration_worker.attempt.completed',
        severity: status === 'completed' ? 'debug' : 'warn',
        payload: {
          reservationFingerprint: completion.attempt.reservationFingerprint,
          surfaceRef: completion.attempt.surfaceRef,
          toolClass: completion.attempt.toolClass,
          actionClass: completion.attempt.actionClass,
          personaClass: completion.attempt.personaClass,
          requestCount: completion.attempt.requestCount,
          status,
        },
        note: `enumeration target attempt ${status}`,
      });
    }
    if (completion.parentSessionId && completion.parentTaskId) {
      await this.sessionStore.updateSessionAsync(completion.parentSessionId, (parent) => {
        const task = parent.workerTasks?.find(
          (candidate) => candidate.taskId === completion.parentTaskId,
        );
        if (task) {
          const attempts = task.enumerationAttempts ?? [];
          if (!attempts.some(
            (attempt) =>
              attempt.reservationFingerprint === completion.attempt!.reservationFingerprint,
          )) {
            attempts.push(completion.attempt!);
          }
          task.enumerationAttempts = attempts;
          task.lastUpdatedAt = Date.now();
        }
        const attemptKey = createAttemptKey(
          completion.attempt!.surfaceRef,
          `enumeration:${completion.attempt!.reservationFingerprint}`,
        );
        const existing = parent.memory.attemptedTechniques[attemptKey];
        parent.memory.attemptedTechniques[attemptKey] = {
          count: (existing?.count ?? 0) + 1,
          lastAttemptTurn: parent.turn,
          result: status === 'completed' ? 'success' : 'failed',
          lastAttemptAt: completion.attempt!.completedAt ?? Date.now(),
        };
        if (!parent.memory.testedEndpoints.includes(completion.attempt!.surfaceRef)) {
          parent.memory.testedEndpoints.push(completion.attempt!.surfaceRef);
        }
        if (status === 'failed') {
          parent.memory.failedApproaches.push({
            endpoint: completion.attempt!.surfaceRef,
            technique: `enumeration:${completion.attempt!.reservationFingerprint}`,
            reason: 'target action failed after server reservation',
            toolCallId: completion.attempt!.reservationFingerprint,
            failedAt: completion.attempt!.completedAt ?? Date.now(),
          });
        }
      });
    }
  }

  private validateWorkerWriteScope(
    session: SessionState | undefined,
    toolName: string,
    descriptor: ToolUseDescriptor,
  ): string | null {
    const writeScope = resolveWorkerWriteScope(session);
    if (!session || !writeScope || writeScope.length === 0) {
      return null;
    }

    if (!descriptor.actions.includes('write')) {
      return null;
    }

    if (WORKER_WRITE_SCOPE_SAFE_TOOLS.has(toolName)) {
      return null;
    }

    if (
      (toolName === 'shell_run' || toolName === 'python_session') &&
      isArtifactScopedWriteScope(writeScope)
    ) {
      return null;
    }

    if (WORKER_WRITE_SCOPE_PATH_BOUND_CANONICAL_TOOLS.has(toolName)) {
      if (!isArtifactScopedWriteScope(writeScope)) {
        return `Tool ${toolName} is not allowed for this worker because path-bound canonical writes require a writeScope limited to /workspace/.artifacts.`;
      }
      if (descriptor.paths.length === 0) {
        return `Tool ${toolName} requires an explicit artifactPath inside the worker writeScope; artifact auto-discovery is not allowed for scoped workers.`;
      }
    } else if (WORKER_WRITE_SCOPE_UNSCOPED_TOOLS.has(toolName) || descriptor.paths.length === 0) {
      return `Tool ${toolName} is not allowed for this worker because writeScope is active and the write target cannot be constrained to an allowed path.`;
    }

    const guard = new PathGuard(session.workspaceDir);
    let normalizedRoots: string[];
    try {
      normalizedRoots = writeScope.map((scopePath) => path.normalize(guard.ensureInsideWorkspace(scopePath)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Worker write scope is invalid: ${message}`;
    }

    for (const targetPath of descriptor.paths) {
      let normalizedTarget: string;
      try {
        normalizedTarget = path.normalize(guard.ensureInsideWorkspace(targetPath));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `Write target ${targetPath} is invalid: ${message}`;
      }

      const matchesScope = normalizedRoots.some((root) =>
        normalizedTarget === root || normalizedTarget.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`),
      );
      if (!matchesScope) {
        return `Write target ${targetPath} is outside the worker writeScope (${writeScope.join(', ')}).`;
      }
    }

    return null;
  }

  public async handleApprovalDecision(
    sessionId: string,
    actionId: string,
    status: 'granted' | 'denied',
    reason?: string,
  ): Promise<{ handled: boolean; needsResume: boolean }> {
    return this.approvalHelper.resolveDecision(sessionId, actionId, status, reason);
  }

  public async getPendingApprovals(sessionId: string) {
    // SIMPLIFIED: Return pendingApproval from session if exists
    const session = this.sessionStore.get(sessionId);
    return session?.pendingApproval ? [session.pendingApproval] : [];
  }

  async execute(
    toolName: string,
    args: ToolArgs,
    contextOrSessionId: ToolExecutionOptions | string,
    legacyContext?: Omit<ToolExecutionContext, 'sessionId'>,
  ): Promise<unknown> {
    const execution = await this.executeWithReceipt(
      toolName,
      args,
      contextOrSessionId,
      legacyContext,
    );
    return execution.result;
  }

  async executeWithReceipt(
    toolName: string,
    args: ToolArgs,
    contextOrSessionId: ToolExecutionOptions | string,
    legacyContext?: Omit<ToolExecutionContext, 'sessionId'>,
  ): Promise<ToolExecutionWithReceipt> {
    let runtimeOutcome: ToolExecutionOutcome | undefined;
    let pipelineContext: ToolExecutionPipelineContext | undefined;
    const captureRuntimeOutcome = (outcome: ToolExecutionOutcome): void => {
      runtimeOutcome = outcome;
    };
    const capturePipelineContext = (pipeline: ToolExecutionPipelineContext): void => {
      pipelineContext = pipeline;
    };
    const executionContext: ToolExecutionContext =
      typeof contextOrSessionId === 'string'
        ? {
          sessionId: contextOrSessionId,
          modelRequestId: legacyContext?.modelRequestId,
          abortSignal: legacyContext?.abortSignal,
          toolCallId: legacyContext?.toolCallId,
          budget: legacyContext?.budget,
          turnNumber: legacyContext?.turnNumber,
          turnId: legacyContext?.turnId,
          rawArgsJson: legacyContext?.rawArgsJson,
          stream: legacyContext?.stream,
          executeModelCall: legacyContext?.executeModelCall,
          captureRuntimeOutcome,
          capturePipelineContext,
        }
        : {
          sessionId: contextOrSessionId.sessionId,
          modelRequestId: contextOrSessionId.modelRequestId,
          abortSignal: contextOrSessionId.abortSignal,
          toolCallId: contextOrSessionId.toolCallId,
          budget: contextOrSessionId.budget,
          turnNumber: contextOrSessionId.turnNumber,
          turnId: contextOrSessionId.turnId,
          rawArgsJson: contextOrSessionId.rawArgsJson,
          stream: contextOrSessionId.stream,
          executeModelCall: contextOrSessionId.executeModelCall,
          captureRuntimeOutcome,
          capturePipelineContext,
        };

    if (typeof executionContext.rawArgsJson === 'string' && executionContext.stream) {
      let parsedArgs: ToolArgs;
      try {
        parsedArgs = this.parseRawArgs(executionContext.rawArgsJson);
      } catch (error) {
        const invalidArgsResult = buildInvalidToolArgsResult(toolName, executionContext.rawArgsJson, error);
        executionContext.stream.toolStarted(toolName, {}, executionContext.toolCallId);
        executionContext.stream.toolOutput('error\n', toolName);
        executionContext.stream.toolResult(toolName, invalidArgsResult, executionContext.toolCallId);
        return {
          result: invalidArgsResult,
          receipt: this.buildExecutionReceipt(
            toolName,
            executionContext.toolCallId,
            invalidArgsResult,
            'failed',
            { modelRequestId: executionContext.modelRequestId },
          ),
        };
      }

      executionContext.stream.toolStarted(toolName, parsedArgs, executionContext.toolCallId);

      const isSelfStreaming = SELF_STREAMING_TOOLS.has(toolName);
      if (!isSelfStreaming) {
        executionContext.stream.toolOutput(buildStartLabel(toolName, parsedArgs) + '\n', toolName);
      }

      const normalizedResult = await this.executeResolvedTool(toolName, parsedArgs, executionContext);

      if (!isSelfStreaming) {
        executionContext.stream.toolOutput(isErrorResult(normalizedResult) ? 'error\n' : 'done\n', toolName);
      }
      executionContext.stream.toolResult(toolName, normalizedResult, executionContext.toolCallId);
      return {
        result: normalizedResult,
        receipt: this.buildExecutionReceipt(
          toolName,
          executionContext.toolCallId,
          normalizedResult,
          runtimeOutcome,
          { modelRequestId: executionContext.modelRequestId, pipeline: pipelineContext },
        ),
      };
    }

    const result = await this.executeResolvedTool(toolName, args, executionContext);
    return {
      result,
      receipt: this.buildExecutionReceipt(
        toolName,
        executionContext.toolCallId,
        result,
        runtimeOutcome,
        { modelRequestId: executionContext.modelRequestId, pipeline: pipelineContext },
      ),
    };
  }

  private async projectRecordedToolExecution(
    record: ToolExecutionRecord,
    toolName: string,
  ): Promise<unknown> {
    const status = normalizeToolExecutionStatus(record);
    if (status === 'succeeded') {
      console.log(
        `[ToolsRegistry] Idempotent hit: ${toolName} (${record.toolCallId}) already succeeded, returning cached result`,
      );
      return record.result;
    }
    if (status === 'claimed') {
      const projection = buildInterruptedToolRecoveryProjection({
        toolCallId: record.toolCallId,
        source: 'tool_execution_lifecycle',
        evidence: {
          dispatchState: 'not_started',
          evidenceRef: `tool-execution:${record.sessionId}:${record.toolCallId}:claimed`,
        },
      });
      return {
        ...projection.result,
        forbidden: true,
        toolExecutionNotStarted: true,
        executionStatus: status,
      };
    }
    if (status === 'started' || status === 'outcome_unknown') {
      const projection = buildInterruptedToolRecoveryProjection({
        toolCallId: record.toolCallId,
        source: 'tool_execution_lifecycle',
        evidence: {
          dispatchState: status === 'started' ? 'started' : 'unknown',
          evidenceRef: `tool-execution:${record.sessionId}:${record.toolCallId}:${status}`,
        },
      });
      return {
        ...projection.result,
        forbidden: true,
        toolExecutionUncertain: true,
        executionStatus: status,
      };
    }
    return {
      error: record.error
        ?? `Tool execution ${toolName} (${record.toolCallId}) is terminal: ${status}`,
      success: false,
      forbidden: true,
      toolExecutionTerminal: true,
      executionStatus: status,
    };
  }

  private async settleRecordedToolBlock(
    ledger: ToolExecutionPort | undefined,
    input: { sessionId: string; toolCallId?: string; reason: string },
  ): Promise<void> {
    if (!ledger || !input.toolCallId) return;
    if (ledger.block) {
      await ledger.block({
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        reason: input.reason,
      });
      return;
    }
    await ledger.fail({
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      error: input.reason,
    });
  }

  private async executeResolvedTool(
    toolName: string,
    args: ToolArgs,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const sessionId = context.sessionId;
    const session = this.sessionStore.get(sessionId);
    const baseTurn = session?.turn ?? 0;
    const turn = context.turnNumber ?? baseTurn + 1;
    const recorder = this.traceRecorder;
    const toolCallId = context.toolCallId;
    const turnId = context.turnId ?? `turn-${turn}`;
    const bindingAdjusted = this.maybeInjectWorkerPlanBinding(session, turnId, toolName, args);
    const boundArgs = bindingAdjusted.args;
    let pipeline = createToolExecutionPipelineContext({
      invocationId: toolCallId ?? uuidv4(),
      sessionId,
      turnId,
      toolName,
      toolCallId,
      modelRequestId: context.modelRequestId,
      args: boundArgs,
    });
    context.capturePipelineContext?.(pipeline);
    const advance = async (
      stage: Parameters<typeof advanceToolExecutionPipeline>[1],
      patch?: Parameters<typeof advanceToolExecutionPipeline>[2],
    ): Promise<void> => {
      pipeline = advanceToolExecutionPipeline(pipeline, stage, patch);
      context.capturePipelineContext?.(pipeline);
      await this.toolLifecycleHooks.emitPipelineStage(pipeline);
    };

    const runtimeTool = await this.getToolModule(toolName);
    if (!runtimeTool) {
      throw new Error(`Tool ${toolName} not found`);
    }
    await advance('resolve');
    const isPlanManagementTool = PLAN_MANAGEMENT_TOOLS.has(toolName);

    const requirements = Array.isArray(runtimeTool.meta.requires)
      ? runtimeTool.meta.requires
      : [];
    if (session) {
      for (const requirement of requirements) {
        if (!this.policyChecker.hasRequirement(session.flags, requirement)) {
          throw new Error(`tool.not_available:${requirement}`);
        }
      }
    }
    await advance('validate');

    const hostedToolExecution = resolveHostedToolExecutionSelection(session);
    const selectedToolExecutionCapability = hostedToolExecution?.capability
      ?? this.runtimeHostCapabilities?.toolExecutions;
    const toolExecutionLedger = hostedToolExecution?.lifecycle ?? this.toolExecutionDb;
    if (
      selectedToolExecutionCapability
      && selectedToolExecutionCapability.durability === 'unsupported'
    ) {
      throw new RuntimeHostCapabilityRegistrationError([
        `host=${this.runtimeHostCapabilities?.hostKind ?? 'research_lab'} lifecycle=toolExecutions durability=unsupported`,
      ]);
    }
    const requiresV2Lifecycle = (selectedToolExecutionCapability?.schemaVersion ?? 1) >= 2;
    if (requiresV2Lifecycle && !supportsDurableToolExecutionLifecycle(toolExecutionLedger)) {
      throw new RuntimeHostCapabilityRegistrationError([
        `host=${this.runtimeHostCapabilities?.hostKind ?? 'research_lab'} lifecycle=toolExecutions schemaVersion=${selectedToolExecutionCapability?.schemaVersion ?? 'missing'} adapter=missing_v2_contract`,
      ]);
    }
    const initialDescriptor = this.policyChecker.describeToolUse({
      toolName,
      toolArgs: boundArgs,
      toolMeta: runtimeTool.meta,
    });
    await advance('describe', { descriptor: initialDescriptor });
    let permissionDecision = this.policyChecker.evaluateToolUsage(session?.toolPolicy, initialDescriptor);

    try {
      permissionDecision = await this.toolLifecycleHooks.emitPermissionDecision({
        sessionId,
        session,
        toolName,
        toolCallId,
        args: boundArgs,
        descriptor: initialDescriptor,
        decision: permissionDecision,
      });
    } catch (error) {
      if (!(error instanceof ToolPipelineInvariantError)) throw error;
      await recorder?.write(sessionId, turn, {
        event: 'tool.pipeline.invariant_rejected',
        severity: 'error',
        payload: {
          requestId: context.modelRequestId,
          toolCallId,
          toolName,
          invariant: error.invariant,
          details: error.details,
        },
        note: `${toolName}: ${error.invariant}`,
      });
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      return {
        error: error.message,
        forbidden: true,
        pipelineInvariant: error.invariant,
      };
    }
    await advance('decide', { decision: permissionDecision });

    await this.recordPermissionDecision(sessionId, turn, permissionDecision, toolCallId);

    if (permissionDecision.behavior === 'ask' && !this.hasGrantedApprovalResume(session, toolName, toolCallId)) {
      const message = permissionDecision.reason;
      await this.approvalHelper.requestApproval(session, sessionId, toolName, boundArgs, {
        toolCallId,
        modelRequestId: context.modelRequestId,
        preview: this.buildApprovalPreview(initialDescriptor, boundArgs),
        reason: message,
      });
      const pendingApproval = this.sessionStore.get(sessionId)?.pendingApproval;
      return {
        error: message,
        forbidden: true,
        approvalRequired: true,
        ...(pendingApproval ? {
          actionId: pendingApproval.actionId,
          tool: pendingApproval.tool,
          toolCallId: pendingApproval.toolCallId,
          modelRequestId: pendingApproval.modelRequestId,
          args: pendingApproval.args,
          preview: pendingApproval.preview,
          reason: pendingApproval.reason,
          requestedAt: pendingApproval.requestedAt,
        } : {}),
      };
    }

    if (permissionDecision.behavior === 'deny') {
      const message = permissionDecision.reason;
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      this.markToolBlocked(sessionId, message, { isPlanManagementTool, session });
      return {
        error: message,
        forbidden: true,
      };
    }

    // Claim ownership before any hook can authorize dispatch. The durable start boundary
    // is crossed only after every generic and product guard has accepted the invocation.
    if (toolCallId && toolExecutionLedger) {
      try {
        const existingExecution = await toolExecutionLedger.findByToolCallId(sessionId, toolCallId);
        if (existingExecution) {
          return this.projectRecordedToolExecution(existingExecution, toolName);
        }
        const input = {
          sessionId,
          turnId,
          toolCallId,
          toolName,
          modelRequestId: context.modelRequestId,
          args: boundArgs,
        };
        const claim = toolExecutionLedger.claim
          ? await toolExecutionLedger.claim(input)
          : { record: await toolExecutionLedger.create(input), claimed: true };
        if (!claim.claimed) {
          return this.projectRecordedToolExecution(claim.record, toolName);
        }
      } catch (ledgerError) {
        console.warn('[ToolsRegistry] Tool execution claim failed; execution denied:', ledgerError);
        return {
          error: 'tool_execution_ledger_unavailable: execution claim could not be persisted',
          forbidden: true,
          toolExecutionLedgerUnavailable: true,
        };
      }
    }
    await advance('claim');

    const preHookResult = await this.toolLifecycleHooks.emitPreToolUse({
      sessionId,
      session,
      toolName,
      toolCallId,
      args: boundArgs,
      descriptor: initialDescriptor,
    });

    if (!preHookResult.continue) {
      const message = preHookResult.blockedReason ?? `Tool ${toolName} was blocked by a lifecycle hook.`;
      await this.settleRecordedToolBlock(toolExecutionLedger, {
        sessionId,
        toolCallId,
        reason: message,
      }).catch((ledgerError) => {
        console.warn('[ToolsRegistry] Failed to record hook block:', ledgerError);
      });
      await this.recordHookBlock(sessionId, turn, toolName, message, toolCallId);
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      this.markToolBlocked(sessionId, message, { isPlanManagementTool, session });
      return {
        error: message,
        forbidden: true,
        hookBlocked: true,
      };
    }

    const effectiveArgs = preHookResult.args;
    const effectiveDescriptor =
      effectiveArgs === boundArgs
        ? initialDescriptor
        : this.policyChecker.describeToolUse({
          toolName,
          toolArgs: effectiveArgs,
          toolMeta: runtimeTool.meta,
        });
    await advance('pre_hooks', {
      args: effectiveArgs,
      descriptor: effectiveDescriptor,
    });
    const writeScopeViolation = this.validateWorkerWriteScope(session, toolName, effectiveDescriptor);
    if (writeScopeViolation) {
      await this.settleRecordedToolBlock(toolExecutionLedger, {
        sessionId,
        toolCallId,
        reason: writeScopeViolation,
      }).catch((ledgerError) => {
        console.warn('[ToolsRegistry] Failed to record write-scope block:', ledgerError);
      });
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      this.markToolBlocked(sessionId, writeScopeViolation, { isPlanManagementTool, session });
      return {
        error: writeScopeViolation,
        forbidden: true,
        workerWriteScope: true,
      };
    }

    const enumerationReservation = await this.reserveEnumerationTargetRequests(
      session,
      toolName,
      effectiveArgs,
      turn,
      toolCallId,
    );
    if ('blockedReason' in enumerationReservation) {
      await this.settleRecordedToolBlock(toolExecutionLedger, {
        sessionId,
        toolCallId,
        reason: enumerationReservation.blockedReason,
      }).catch(() => undefined);
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      return {
        error: enumerationReservation.blockedReason,
        forbidden: true,
        enumerationWorkerGuard: true,
      };
    }
    const attackReservation = await this.reserveAttackTargetRequests(
      session,
      toolName,
      effectiveArgs,
      context.budget,
      turn,
      toolCallId,
    );
    if ('blockedReason' in attackReservation) {
      await this.settleRecordedToolBlock(toolExecutionLedger, {
        sessionId,
        toolCallId,
        reason: attackReservation.blockedReason,
      }).catch(() => undefined);
      await this.telemetry.recordForbidden(sessionId, toolName, turn, recorder);
      return {
        error: attackReservation.blockedReason,
        forbidden: true,
        attackWorkerGuard: true,
      };
    }

    if (toolCallId && toolExecutionLedger && requiresV2Lifecycle) {
      try {
        await toolExecutionLedger.markStarted?.({ sessionId, toolCallId });
      } catch (ledgerError) {
        console.warn('[ToolsRegistry] Tool execution start failed; dispatch denied:', ledgerError);
        return {
          error: 'tool_execution_ledger_unavailable: dispatch boundary could not be persisted',
          forbidden: true,
          toolExecutionLedgerUnavailable: true,
        };
      }
    }
    await advance('start');

    const meta = await this.telemetry.recordStart(
      sessionId,
      toolName,
      effectiveArgs,
      turn,
      session?.currentPlanStepId ?? null,
      recorder,
      {
        toolCallId,
        modelRequestId: context.modelRequestId,
        progressKind: runtimeTool.meta.progressKind,
        permission: {
          behavior: permissionDecision.behavior,
          source: permissionDecision.source,
          reason: permissionDecision.reason,
          category: permissionDecision.descriptor.category,
          actions: permissionDecision.descriptor.actions,
          paths: permissionDecision.descriptor.paths,
          hosts: permissionDecision.descriptor.hosts,
          command: permissionDecision.descriptor.command,
        },
      },
    );
    await advance('dispatch');

    let enumerationAttemptStatus: 'completed' | 'failed' = 'failed';
    try {
      const executionStartedAt = Date.now();
      const enumerationWorkerSession =
        session?.coordination?.role === 'worker' &&
        session.coordination.workerType === 'enumeration_worker';
      const rawResult =
        typeof context.rawArgsJson === 'string' && !enumerationWorkerSession
          ? await this.executeWithRetry({
            runtimeTool,
            toolName,
            args: effectiveArgs,
            sessionId,
            session,
            toolCallId: context.toolCallId,
            turnNumber: turn,
            budget: context.budget,
            abortSignal: context.abortSignal,
            executeModelCall: context.executeModelCall,
            captureRuntimeOutcome: context.captureRuntimeOutcome,
            isPlanManagementTool,
          })
          : await this.executePreparedTool({
            runtimeTool,
            toolName,
            args: effectiveArgs,
            sessionId,
            session,
            toolCallId: context.toolCallId,
            turnNumber: turn,
            budget: context.budget,
            abortSignal: context.abortSignal,
            executeModelCall: context.executeModelCall,
            captureRuntimeOutcome: context.captureRuntimeOutcome,
            isPlanManagementTool,
          });
      const result = freezeToolExecutionResult(attachEnumerationAttemptReceipt(
        rawResult,
        enumerationReservation.attempt,
      ));
      enumerationAttemptStatus = isErrorResult(result) ? 'failed' : 'completed';
      await advance('normalize', {
        result,
        outcome: isErrorResult(result) ? 'failed' : 'succeeded',
      });

      if (toolCallId && toolExecutionLedger) {
        try {
          const durationMs = Date.now() - meta.startedAt;
          await toolExecutionLedger.complete({
            sessionId,
            toolCallId,
            result,
            durationMs,
          });
        } catch (dbErr) {
          console.warn(`[ToolsRegistry] Failed to record completion:`, dbErr);
          await toolExecutionLedger.markOutcomeUnknown?.({
            sessionId,
            toolCallId,
            reason: 'terminal_result_settlement_failed_after_dispatch',
          }).catch(() => undefined);
          return freezeToolExecutionResult({
            error: 'tool_execution_settlement_failed: external outcome requires reconciliation',
            forbidden: true,
            toolExecutionUncertain: true,
          });
        }
      }
      await advance('settle', {
        result,
        outcome: isErrorResult(result) ? 'failed' : 'succeeded',
      });

      await this.toolLifecycleHooks.emitPostToolUse({
        sessionId,
        session,
        toolName,
        toolCallId,
        args: effectiveArgs,
        descriptor: effectiveDescriptor,
        result,
        durationMs: Date.now() - executionStartedAt,
      });
      await advance('post_hooks');
      await this.reconcileWorkerPlanBindingSuccess(sessionId, turnId, toolName, effectiveArgs, result);
      await advance('project');

      await this.telemetry.recordFinish(sessionId, toolName, result, turn, meta, recorder);
      await advance('observe');
      return result;
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      await advance('normalize', {
        outcome: context.abortSignal?.aborted ? 'interrupted' : 'failed',
        errorClass: normalizedError.name || 'Error',
      });
      if (toolCallId && toolExecutionLedger) {
        try {
          await toolExecutionLedger.fail({
            sessionId,
            toolCallId,
            error: normalizedError.message,
            durationMs: Date.now() - meta.startedAt,
          });
        } catch (dbErr) {
          console.warn(`[ToolsRegistry] Failed to record tool failure:`, dbErr);
          await toolExecutionLedger.markOutcomeUnknown?.({
            sessionId,
            toolCallId,
            reason: 'failure_settlement_failed_after_dispatch',
          }).catch(() => undefined);
          return freezeToolExecutionResult({
            error: 'tool_execution_settlement_failed: external outcome requires reconciliation',
            forbidden: true,
            toolExecutionUncertain: true,
          });
        }
      }
      await advance('settle', {
        outcome: context.abortSignal?.aborted ? 'interrupted' : 'failed',
        errorClass: normalizedError.name || 'Error',
      });
      await this.toolLifecycleHooks.emitPostToolUseFailure({
        sessionId,
        session,
        toolName,
        toolCallId,
        args: effectiveArgs,
        descriptor: effectiveDescriptor,
        error: normalizedError,
        durationMs: Date.now() - meta.startedAt,
      });
      await advance('post_hooks');

      if (error instanceof ApprovalDeniedError) {
        const message = 'Action denied by operator' + (error.reason ? `: ${error.reason}` : '');
        this.markToolBlocked(sessionId, message, {
          isPlanManagementTool,
          session: this.sessionStore.get(sessionId),
        });
        await this.telemetry.recordFailure(
          sessionId,
          toolName,
          error,
          turn,
          meta,
          recorder,
          true,
          error.reason
        );
        await advance('project');
        await advance('observe');
        return freezeToolExecutionResult(attachEnumerationAttemptReceipt(
          { error: message, denied: true },
          enumerationReservation.attempt,
        ));
      }

      if (!isPlanManagementTool) {
        this.handleToolFailure(sessionId, normalizedError);
      }

      const isAbort =
        context.abortSignal?.aborted ||
        normalizedError.name === 'AbortError' ||
        normalizedError.message === 'The operation was aborted' ||
        normalizedError.message === 'Aborted';

      if (isAbort) {
        await this.telemetry.recordAbort(sessionId, toolName, turn, meta.startedAt, recorder);
        await this.telemetry.recordFailure(sessionId, toolName, normalizedError, turn, meta, recorder);
        await advance('project');
        await advance('observe');
        throw normalizedError;
      }

      await this.telemetry.recordFailure(sessionId, toolName, normalizedError, turn, meta, recorder);
      await advance('project');
      await advance('observe');

      return freezeToolExecutionResult(attachEnumerationAttemptReceipt(
        {
          ok: false,
          error: normalizedError.message,
          details: {
            tool: toolName,
            turn,
          },
        },
        enumerationReservation.attempt,
      ));
    } finally {
      await this.releaseEnumerationTargetRequests(
        sessionId,
        enumerationReservation,
        enumerationAttemptStatus,
      );
      await this.releaseAttackTargetRequests(sessionId, attackReservation);
    }
  }

  getToolSchemas(): ToolDefinition[] {
    if (!this.isReady) {
      return [];
    }
    return Array.from(this.manifests.values()).map((manifest) => ({
      name: manifest.id,
      description: toolContractRegistry.get(manifest.id)?.description ?? manifest.summary,
      parameters: (toolContractRegistry.get(manifest.id)?.schema as ToolDefinition['parameters']) ?? (manifest.argsSchema as ToolDefinition['parameters']) ?? {
        type: 'object',
        properties: {},
      },
    }));
  }

  async getUnifiedPipelineCoverage(): Promise<{
    schema: typeof TOOL_EXECUTION_PIPELINE_SCHEMA;
    owner: 'ToolsRegistry.executeResolvedTool';
    executableToolIds: string[];
    uncoveredToolIds: string[];
  }> {
    const catalog = await this.listCatalogTools();
    const executableToolIds = catalog.map(({ manifest }) => manifest.id);
    const schemaToolIds = new Set(this.getToolSchemas().map(({ name }) => name));
    return {
      schema: TOOL_EXECUTION_PIPELINE_SCHEMA,
      owner: 'ToolsRegistry.executeResolvedTool',
      executableToolIds,
      uncoveredToolIds: executableToolIds.filter((toolId) => !schemaToolIds.has(toolId)),
    };
  }

  /**
   * Clean up pending approvals when a session terminates.
   * SIMPLIFIED: Cleanup is now a no-op - pendingApproval is just a field on session.
   */
  async cleanupSessionApprovals(sessionId: string): Promise<{ deleted: number }> {
    // SIMPLIFIED: Clear pendingApproval from session if exists
    const session = this.sessionStore.get(sessionId);
    if (session?.pendingApproval) {
      session.pendingApproval = undefined;
      await this.sessionStore.setAsync(sessionId, session, 'approval-cleanup');
      return { deleted: 1 };
    }
    return { deleted: 0 };
  }

  async flushWorkspaceProjection(
    options: WorkspaceProjectionFlushOptions,
  ): Promise<WorkspaceProjectionFlushResult> {
    if (!this.sandboxManager) {
      return {
        flushed: false,
        scopes: [],
        written: 0,
        dirtyCount: 0,
        warning: 'Projection refresh skipped: sandbox manager is not configured.',
      };
    }

    return flushWorkspaceProjectionForSession({
      sessionStore: this.sessionStore,
      sandbox: this.sandboxManager,
      trace: this.traceRecorder,
      sessionId: options.sessionId,
      turnNumber: options.turnNumber,
      reason: options.reason,
      scopes: options.scopes,
      forceModel: options.forceModel,
    });
  }
}
