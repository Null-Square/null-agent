import type { AgentType, PromptProfile } from '../prompts/agentPrompts';
import type { SessionStateMachine } from '../state/SessionStateMachine';
import type { SessionExecutionProfileV1 } from '../runtime/ExecutionRuntimeRegistry';
import type { AttackMissionV1, AttackResultStatus, AttackResultV1 } from '../workers/attackContracts';
import type { AgentMemory } from './memory';

/**
 * Shared runtime session types for the agent-brain. These were formerly defined
 * under ai-agent/domain/types but live here so the runtime no longer depends on
 * the legacy package.
 */

export type Role = 'user' | 'assistant' | 'tool';

export type MessageVisibility = 'public' | 'internal';
export type MessageSource =
  | 'human'
  | 'planner_kickoff'
  | 'executor_kickoff'
  | 'plan_feedback'
  | 'phase_replan_request'
  | 'step_transition_briefing'
  | 'worker_state_continuation';

export type ToolExecutionOutcome = 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'interrupted' | 'awaiting_approval';

export interface ToolExecutionReceiptV1 {
  schema: 'tool-execution-receipt/v1';
  toolName: string;
  toolCallId?: string;
  modelRequestId?: string;
  outcome: ToolExecutionOutcome;
  pipeline?: {
    schema: 'tool-execution-pipeline/v1';
    completedStages: string[];
  };
}

export interface MessageMetadata extends Record<string, unknown> {
  visibility?: MessageVisibility;
  source?: MessageSource;
  /** Canonical runtime outcome. It remains stable when result content is projected or compacted. */
  toolExecution?: ToolExecutionReceiptV1;
  provider_reasoning?: {
    provider: string;
    model?: string;
    format: 'reasoning_content';
    content: string;
    capturedAt: string;
  };
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
  toolName?: string;
  status?: 'sending' | 'sent' | 'error';
  /** For assistant messages with tool calls - persisted for proper tool result linking */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  /** For tool result messages - links back to the tool_call that generated this result */
  toolCallId?: string;
  /** OpenAI tool result field name for compatibility */
  tool_call_id?: string;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'error';
export type MissionPhaseKey =
  | 'planning'
  | 'recon'
  | 'enumeration'
  | 'validation'
  | 'exploitation'
  | 'evidence'
  | 'control_assessment'
  | 'reporting'
  | 'review_mapping'
  | 'review_analysis'
  | 'review_validation'
  | 'review_reporting';

export type EnumerationSourceMode = 'blackbox' | 'greybox' | 'whitebox';
export type EnumerationImpactCeiling = 'non_destructive' | 'poc';
export type EnumerationSurfaceKind =
  'endpoint_set' | 'api_operation_set' | 'path_prefix_set' | 'component' | 'client_bundle_set' | 'repository_path_set';

export interface EnumerationSkillRefV1 {
  slug: string;
  versionHash: string;
}

export interface EnumerationMissionV1 {
  schemaVersion: 1;
  kind: 'enumeration_hunt_v1';
  phaseAttemptId: string;
  targetRef: string;
  surface: {
    kind: EnumerationSurfaceKind;
    refs: string[];
  };
  techniqueIds: string[];
  primarySkill: EnumerationSkillRefV1;
  supportingSkills: EnumerationSkillRefV1[];
  personaRefs: string[];
  sourceMode: EnumerationSourceMode;
  impactCeiling: EnumerationImpactCeiling;
  budgets: {
    maxToolCalls: number;
    maxTargetRequests: number;
    maxRequestConcurrency: number;
    maxWallSeconds: number;
    maxArtifactFiles: number;
    maxArtifactBytes: number;
    maxLeads: number;
    maxStateChanges: 0;
  };
  stop: {
    whenTechniquesExhausted: true;
    whenBlockedByPolicy: true;
    maxHighConfidenceLeads: number;
  };
  missionFingerprint: string;
}

export interface MissionEnvelope {
  phase?: MissionPhaseKey;
  question: string;
  whyReadyNow: string;
  requiredEvidence: string[];
  expectedArtifact: string;
  stopCondition: string;
  assignedSkills?: string[];
  parallelSafeWith?: string[];
  revalidatesFindingId?: string;
  enumeration?: EnumerationMissionV1;
  attack?: AttackMissionV1;
}

export interface PlanItem {
  id: string;
  title: string;
  status: StepStatus;
  mission?: MissionEnvelope;
  notes?: string;
  startedAt?: number;
  completedAt?: number;
  blockedReason?: string;
  lastTool?: string;
  outputSnippet?: string;
  artifactLinks?: string[];
  checkpointId?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: StepStatus;
  notes?: string;
}

export interface ApprovalPreview {
  cmd?: string;
  path?: string;
  diff?: string;
  risk?: string[];
}

export interface ApprovalRequest {
  actionId: string;
  tool: string;
  toolCallId?: string;
  modelRequestId?: string;
  args?: Record<string, unknown>;
  preview?: ApprovalPreview;
  expiresAt?: string;
  requestedAt?: number;
  reason?: string;
}

export type PendingApproval = ApprovalRequest & { toolCallId: string };

export interface CheckpointMetadata {
  id: string;
  ts: string;
  filesCount: number;
  sizeBytes: number;
}

export interface ToolAccessPolicy {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  network?: 'none' | 'allowlist' | 'bridge';
  allowlist_hosts?: string[];
  rules?: ToolPolicyRule[];
}

export type ToolPolicyBehavior = 'allow' | 'deny' | 'ask';

export type ToolPolicyAction =
  'read' | 'write' | 'execute' | 'network' | 'browser' | 'research' | 'plan' | 'report' | 'other';

export interface ToolPolicyRule {
  behavior: ToolPolicyBehavior;
  tool?: string | string[];
  category?: string | string[];
  action?: ToolPolicyAction | ToolPolicyAction[];
  path?: string | string[];
  host?: string | string[];
  command?: string | string[];
  note?: string;
}

export interface SessionTaskMeta {
  id: string;
  title: string;
  versionHash?: string;
  category?: string;
  summary?: string;
  vars: Record<string, unknown>;
  starterPrompt?: string;
}

export type WorkerType =
  | 'recon_worker'
  | 'enumeration_worker'
  | 'validator_worker'
  | 'attack_worker'
  | 'evidence_worker'
  | 'repo_research_worker'
  | 'compliance_control_worker';

export type LegacyWorkerType = 'exploit_worker' | 'report_writer_worker';

export type AnyWorkerType = WorkerType | LegacyWorkerType;

export type WorkerTaskStatus =
  'pending' | 'running' | 'blocked' | 'awaiting_input' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export type WorkerRunMode = 'blocking' | 'background';

export type WorkerContinuationMode = 'spawn' | 'continue';

export type WorkerDependencyMode = 'dependency' | 'sidecar';

export interface WorkerTaskBudget {
  maxToolCalls?: number;
  maxTargetRequests?: number;
  maxRequestConcurrency?: number;
  maxWallSeconds?: number;
  maxArtifactFiles?: number;
  maxArtifactBytes?: number;
  maxLeads?: number;
  maxStateChanges?: number;
}

export type EnumerationBlockerCodeV1 =
  | 'credential_required'
  | 'auth_required'
  | 'account_state_required'
  | 'rate_limited'
  | 'target_unavailable'
  | 'out_of_scope'
  | 'waf_blocked'
  | 'policy_denied'
  | 'tool_unavailable'
  | 'prerequisite_missing'
  | 'budget_exhausted'
  | 'wall_timeout'
  | 'artifact_limit'
  | 'scope_ambiguous';

export interface EnumerationLeadV1 {
  localId: string;
  serverFingerprint?: string;
  riskFamily: string;
  techniqueId: string;
  targetRef: string;
  surfaceRef: string;
  hypothesis: string;
  observation: string;
  validationGoal: string;
  requiredControls: string[];
  prerequisites: string[];
  evidenceRefs: string[];
  evidenceState: 'durable' | 'needs_evidence';
  confidence: number;
  priority: 'low' | 'medium' | 'high';
  authContextClass: string;
  attemptFingerprints: string[];
}

export interface EnumerationNegativeV1 {
  localId: string;
  surfaceRef: string;
  techniqueId: string;
  controlOrBaseline: string;
  attemptFingerprints: string[];
  evidenceRefs: string[];
  conclusion: string;
  confidence: number;
}

export interface EnumerationAttemptV1 {
  fingerprint: string;
  toolClass: string;
  actionClass: string;
  surfaceRef: string;
  techniqueId: string;
  personaClass: string;
  startedAt: string;
  endedAt: string;
  status: 'completed' | 'blocked' | 'failed';
  requestCount: number;
  evidenceRefs: string[];
  blockerCode?: EnumerationBlockerCodeV1;
}

export interface EnumerationCoverageV1 {
  requested: {
    surfaceRefs: string[];
    techniqueIds: string[];
    personaClasses: string[];
  };
  attempted: {
    surfaceRefs: string[];
    techniqueIds: string[];
    personaClasses: string[];
  };
  counts: {
    attempts: number;
    requests: number;
    leads: number;
    negativeResults: number;
  };
  uncovered: Array<{
    kind: 'surface' | 'technique' | 'persona';
    ref: string;
    reason: string;
  }>;
}

export interface EnumerationBlockerV1 {
  code: EnumerationBlockerCodeV1;
  message: string;
  surfaceRef?: string;
  techniqueId?: string;
  prerequisite?: string;
}

export interface EnumerationArtifactRefV1 {
  id: string;
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
  purpose: string;
  sensitivity: 'public' | 'internal' | 'sensitive';
}

export interface RecommendedValidationMissionV1 {
  leadLocalId: string;
  question: string;
  requiredEvidence: string[];
  stopCondition: string;
  priority: 'low' | 'medium' | 'high';
}

export interface EnumerationWorkerResultV1 {
  schemaVersion: 1;
  missionFingerprint: string;
  resultHash: string;
  status: 'completed' | 'partial' | 'blocked' | 'failed';
  targetRef: string;
  surfaceRefs: string[];
  skills: Array<EnumerationSkillRefV1 & { role: 'primary' | 'supporting' }>;
  leads: EnumerationLeadV1[];
  negativeResults: EnumerationNegativeV1[];
  attempts: EnumerationAttemptV1[];
  coverage: EnumerationCoverageV1;
  blockers: EnumerationBlockerV1[];
  artifacts: EnumerationArtifactRefV1[];
  recommendedValidationMissions: RecommendedValidationMissionV1[];
}

export interface WorkerResultArtifact {
  taskId: string;
  workerType: AnyWorkerType;
  summary: string;
  findings: string[];
  evidenceRefs: string[];
  sourceEvidenceRefs?: string[];
  parentReadableEvidenceRefs?: string[];
  parentReadableManifestPath?: string;
  sourceSessionId?: string;
  touchedTargets: string[];
  recommendedNextAction?: string;
  confidence?: number;
  enumeration?: EnumerationWorkerResultV1;
  attack?: AttackResultV1;
}

export interface WorkerToolPreflightEntry {
  tool: string;
  reason: string;
}

export interface WorkerToolPreflight {
  advertisedTools: string[];
  executableTools: string[];
  withheldTools?: WorkerToolPreflightEntry[];
}

export interface WorkerTaskRecord {
  taskId: string;
  parentSessionId: string;
  workerSessionId: string;
  workerType: AnyWorkerType;
  waveIndex?: number;
  planStepId?: string;
  mission?: MissionEnvelope;
  status: WorkerTaskStatus;
  reason: string;
  task: string;
  expectedArtifactType: string;
  executionMode: WorkerRunMode;
  dependencyMode?: WorkerDependencyMode;
  continuationMode: WorkerContinuationMode;
  writeScope?: string[];
  toolPolicy?: ToolAccessPolicy;
  toolPreflight?: WorkerToolPreflight;
  budget?: WorkerTaskBudget;
  continuationCount?: number;
  retryIndex?: number;
  targetRequestsUsed?: number;
  enumerationAttempts?: EnumerationServerAttemptRecordV1[];
  deadlineAt?: number;
  enumerationCapability?: {
    enabled: boolean;
    cohort: 'disabled' | 'allowlist' | 'percentage';
    policyVersion: number;
    catalogVersion: string;
  };
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  lastUpdatedAt?: number;
  lastStatusReason?: string;
  lastError?: string;
  summary?: string;
  artifact?: WorkerResultArtifact;
  enumerationDisposition?: EnumerationDispositionRecordV1;
  enumerationDispositionReservation?: {
    payloadHash: string;
    acquiredAt: number;
    ownerId?: string;
  };
  attackDisposition?: {
    action: 'disposition' | 'acknowledge_denied';
    resultStatus?: AttackResultStatus;
    evidenceIds: string[];
    terminalReason?: string;
    completedAt: number;
  };
}

export interface EnumerationServerAttemptRecordV1 {
  reservationFingerprint: string;
  fingerprintsByTechnique: Record<string, string>;
  surfaceRef: string;
  toolClass: string;
  actionClass: string;
  personaClass: string;
  requestCount: number;
  reservedAt: number;
  completedAt?: number;
  status: 'reserved' | 'completed' | 'failed';
}

export type EnumerationLeadDispositionAction = 'accept' | 'merge_duplicate' | 'defer' | 'reject';

export interface EnumerationLeadDispositionV1 {
  leadLocalId: string;
  action: EnumerationLeadDispositionAction;
  existingLeadId?: string;
  reason?: string;
  nextPrerequisite?: string;
}

export interface EnumerationDispositionRecordV1 {
  action: 'disposition' | 'acknowledge_terminal';
  resultHash?: string;
  terminalStateVersion?: string;
  payloadHash: string;
  completedAt: number;
  leadDispositions: EnumerationLeadDispositionV1[];
  canonicalLeadIds: string[];
  validatorEligibleLeadIds: string[];
  coverageAcknowledged: boolean;
  negativeResultsAcknowledged: boolean;
  terminalReason?: string;
}

export type SessionCoordinationRole = 'direct' | 'worker';

export interface SessionCoordination {
  role: SessionCoordinationRole;
  parentSessionId?: string;
  parentTaskId?: string;
  workerType?: AnyWorkerType;
  expectedArtifactType?: string;
  writeScope?: string[];
  executionMode?: WorkerRunMode;
  dependencyMode?: WorkerDependencyMode;
  continuationMode?: WorkerContinuationMode;
  maxToolCalls?: number;
  maxTargetRequests?: number;
  targetRequestsUsed?: number;
  maxRequestConcurrency?: number;
  activeTargetRequests?: number;
  enumerationMissionReservations?: Record<
    string,
    {
      taskId: string;
      reservedAt: number;
    }
  >;
  enumerationAttemptReservations?: Record<string, EnumerationServerAttemptRecordV1>;
  enumerationAttempts?: EnumerationServerAttemptRecordV1[];
  deadlineAt?: number;
}

export interface SessionFlags extends Record<string, unknown> {
  /** Immutable execution provenance resolved once when the session is admitted. */
  execution_profile?: SessionExecutionProfileV1;
  policy_base?: {
    toolPolicy?: ToolAccessPolicy | null;
  };
  policy_lock?: {
    profileKey?: string;
  };
  subscription?: {
    planSlug?: string;
    plan_slug?: string;
  };
  brain_policy?: {
    profile?: string;
    source?: string;
  };
  scheduler?: {
    scheduleId?: string;
  };
  cache_control?: {
    prefixHash?: string;
    createdAt?: number;
    lastAction?: 'create' | 'hit';
  };
  token_usage_history?: {
    entries?: Array<
      Record<string, unknown> & {
        ts?: number;
        turn?: number | null;
        credits?: number;
      }
    >;
  };
  artifacts?: Record<string, unknown> & {
    hasSummary?: boolean;
    hasReport?: boolean;
    summaryPath?: string;
    reportPath?: string;
  };
  session?: {
    completed?: boolean;
    workerTokenLimitPartialResult?: boolean;
    tokenLimit?: Record<string, unknown>;
  };
  guard?: Record<string, unknown>;
  skillMethodologyReads?: Record<
    string,
    {
      readAt: string;
      byPlanStepId?: string;
      path?: string;
    }
  >;
  activeMethodologyRequirement?: {
    stepId: string;
    skills: string[];
    paths: string[];
  };
  lifecycleGateFailures?: Record<
    string,
    {
      key?: string;
      toolName?: string;
      code?: string;
      count?: number;
      message?: string;
      lastRejectedAt?: number;
      lastRejectedPayload?: Record<string, unknown>;
      gate?: Record<string, unknown>;
      circuitBreaker?: boolean;
    }
  >;
  delegationActivationGuidance?: string;
  ephemeralNudge?: string;
  blocked_reason?: string;
  error_retry?: {
    retryCount: number;
    lastErrorAt?: number;
    lastCode?: string;
    lastMessage?: string;
    retryAfterMs?: number;
  };
}

// SessionStatus canonical definition is in @null-ai/contracts - re-exported here for backward compatibility
// See packages/contracts/src/session/types.ts for full definition
import type { TimelineEntry } from '@null-ai/contracts';
import { type SessionStatus as ContractSessionStatus, deriveStatus as contractsDeriveStatus } from '@null-ai/contracts';
export type SessionStatus = ContractSessionStatus;

/**
 * Derive SessionStatus from canonical state fields.
 *
 * CANONICAL STATE MODEL (Jan 2026):
 * - stateMachine.isProcessing(): true when API call or tool execution is in progress
 * - pendingApproval: set when tool requires approval
 * - blockedReason: durable block reason from DB (e.g., 'credits_exhausted')
 *
 * API responses should use this function instead of storing status directly.
 * This ensures deterministic, predictable behavior aligned with Codex/Claude.
 */
export function deriveStatus(session: {
  stateMachine?: { isProcessing: () => boolean };
  pendingApproval?: { toolCallId: string };
  blockedReason?: string;
  flags?: { blocked_reason?: string };
}): SessionStatus {
  const blockedReason = session.blockedReason ?? (session.flags?.blocked_reason as string | undefined);
  const isProcessing = session.stateMachine?.isProcessing() ?? false;
  return contractsDeriveStatus({
    blockedReason,
    isProcessing,
    pendingApproval: session.pendingApproval,
  }) as SessionStatus;
}

export interface SessionState {
  id: string;
  version?: number;
  userId?: string;
  messages: Message[];
  plan: PlanItem[];
  scratchTodos?: TodoItem[];
  /** Structured memory for tracking discoveries and failed attempts */
  memory: AgentMemory;
  flags: SessionFlags;
  workspaceDir: string;

  /** Nullable - only set when tool requires approval */
  pendingApproval?: PendingApproval;

  /**
   * Reason session is blocked
   * Used by deriveStatus() to determine paused vs idle.
   * Values include prerequisite waits, explicit Stop, and presentation reasons.
   */
  blockedReason?: string;
  /** Machine-readable metadata for the current blocked reason, e.g. system pause cause code. */
  blockedMeta?: Record<string, unknown>;

  // ============================================================================
  // INTERNAL FIELDS: Used by SessionStore for turn coordination
  // ============================================================================

  /** Internal status used by SessionStore */
  status?: SessionStatus;

  /**
   * State machine for processing state transitions.
   * SINGLE SOURCE OF TRUTH for processing state.
   * Use stateMachine.isProcessing() to check if session is processing.
   */
  stateMachine?: SessionStateMachine;

  /** Internal currentTurn used by SessionStore for abort coordination */
  currentTurn?: {
    controller: AbortController;
    reason?: string;
    startedAt?: number;
    toolCalls?: number;
    abortEventEmitted?: boolean;
  };

  containerId?: string;
  profileKey?: string;
  promptProfile?: PromptProfile;
  provider?: string;
  extraContext?: string;
  createdAt: number;
  lastActive: number;
  turn: number; // Keep for usage tracking only
  checkpoints: Record<string, CheckpointMetadata>;
  lastCheckpoint?: CheckpointMetadata;
  task?: SessionTaskMeta;
  title?: string;
  toolPolicy?: ToolAccessPolicy;
  softContextBlocks?: string[];
  planVersionHash?: string;
  sandboxProfile?: string;
  sandboxImage?: string;
  scopeId?: string;
  agentType?: AgentType;
  currentPlanStepId?: string;
  mode?: 'interactive' | 'automated';
  executionMode?: 'discovery' | 'validation' | 'evidence' | 'escalation' | 'summarization';
  coordination?: SessionCoordination;
  workerTasks?: WorkerTaskRecord[];
  workerResult?: WorkerResultArtifact;
  summary?: string;
  usage?: SessionUsage;
  artifacts?: SessionArtifact[];
  liveToolStreams?: Record<string, LiveToolStreamState>;
  timeline?: TimelineEntry[];
  /** Durable completion flag for automated runs with a persisted report artifact */
  completed?: boolean;
  // REMOVED Dec 2025: archivedAt, deletedAt - archive feature unused

  // ============================================================================
  // MODEL CONTEXT CONFIGURATION (wired from DB, not hardcoded)
  // ============================================================================
  /** Model name selected for this session (e.g., qwen3-coder-flash) */
  modelName?: string;
  /** Model's total context window in tokens (e.g., 100000 for Qwen 3 Max) */
  modelContextWindow?: number;
  /** Model's max output tokens (e.g., 8192) */
  modelMaxOutputTokens?: number;
  /** Optional per-session sampling temperature for reproducible evaluations. */
  modelTemperature?: number;

  // ============================================================================
  // AUTO-COMPACTION STATE (summarize older messages instead of dropping)
  // ============================================================================
  /** LLM-generated summary of older messages that were compacted */
  compactionSummary?: string;
  /** Turn number where compaction occurred (messages before this are summarized) */
  compactionCutoffTurn?: number;
  /** Sanitized message count already folded into compactionSummary */
  compactionMessageCutoff?: number;
  /** Compaction version - increments each time compaction runs */
  compactionVersion?: number;
}

export interface SessionArtifact {
  id: string;
  filePath: string;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  createdAt: number;
  storage?: 'local' | 's3';
  bucket?: string;
  /** Local staging path used during uploads */
  localPath?: string;
}

export type LiveToolStreamStatus = 'idle' | 'running' | 'completed' | 'error';

export interface LiveToolStreamState {
  name: string;
  chunks: string[];
  status: LiveToolStreamStatus;
  command?: string;
  result?: unknown;
  lastUpdated: number;
}

export interface SessionUsage {
  promptTokens: number;
  cachedPromptTokens?: number;
  cacheWriteTokens?: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  overhead?: number;
  platformCost?: number;
  platformPrice?: number;
  credits?: number;
  currency?: string;
  model?: string;
  contextWindow?: number | null;
  contextRemaining?: number | null;
}

export type SandboxNetworkMode = 'none' | 'bridge' | 'host' | `container:${string}` | (string & {});

export interface SandboxPolicySummary {
  profile: string;
  privileged: boolean;
  capDrop: string[];
  capAdd: string[];
  readonlyRootfs: boolean;
  network: SandboxNetworkMode;
  seccomp?: string | null;
}

export type StreamEvent =
  | { type: 'token'; data: string }
  | { type: 'message'; data: Message }
  | { type: 'message_start'; data: { role: string } & Record<string, unknown> }
  | {
      type: 'message_end';
      data: { messageId?: string } & Record<string, unknown>;
    }
  | { type: 'plan_update'; data: PlanItem[] }
  | {
      type: 'tool_started';
      data: {
        name: string;
        args: Record<string, unknown>;
        toolCallId?: string;
      };
    }
  | { type: 'tool_output'; data: { name: string; chunk: string } }
  | {
      type: 'tool_result';
      data: { name: string; result: unknown; toolCallId?: string };
    }
  | { type: 'done' }
  | { type: 'error'; data: { code: string; message: string } }
  | { type: 'ping' }
  | { type: 'approval_needed'; data: ApprovalRequest }
  | { type: 'approval_granted'; data: { actionId: string } }
  | { type: 'approval_denied'; data: { actionId: string; reason?: string } }
  | { type: 'checkpoint_created'; data: CheckpointMetadata }
  | { type: 'checkpoint_restored'; data: { id: string } }
  | { type: 'aborted'; data: { reason?: string } }
  | { type: 'plan_step_started'; data: { stepId: string } }
  | {
      type: 'plan_step_updated';
      data: {
        stepId: string;
        status: StepStatus;
        notes?: string;
        outputSnippet?: string;
        lastTool?: string;
        artifactLinks?: string[];
        checkpointId?: string;
        blockedReason?: string;
        startedAt?: number;
        completedAt?: number;
      };
    }
  | {
      type: 'task_selected';
      data: {
        id: string;
        title: string;
        category?: string;
        summary?: string;
        versionHash?: string;
        vars?: Record<string, unknown>;
      };
    }
  | { type: 'timeline_event'; data: TimelineEntry }
  | { type: 'usage.recorded'; data: Record<string, unknown> }
  | {
      type: 'plan_warning';
      data: {
        turn: number;
        pendingStepIds: string[];
        pendingSteps: Array<{ id: string; title: string }>;
        message: string;
      };
    }
  | { type: 'sandbox_policy'; data: SandboxPolicySummary }
  | { type: 'docker_build_start'; data: { profileId: string; message: string } }
  | { type: 'docker_build_log'; data: { profileId: string; chunk: string } }
  | {
      type: 'docker_build_end';
      data: { profileId: string; status: 'success' | 'failed'; error?: string };
    }
  | { type: 'warning'; data: { code: string; message: string } }
  // P2 FIX (Dec 2025): Deadlock event for structured stop
  | { type: 'deadlock'; data: { tool: string; message: string } }
  // Context overflow notification (Dec 2025): Warn user when history is trimmed
  | {
      type: 'context_trimmed';
      data: {
        droppedMessages: number;
        keptMessages: number;
        usedTokens: number;
        tokenBudget: number;
        percentUsed: number;
      };
    }
  // Real-time context estimate (Dec 2025): Live CTX bar updates before LLM call
  | {
      type: 'context_estimate';
      data: {
        estimatedTokens: number;
        contextWindow: number;
        maxHistoryTokens: number;
        percentUsed: number;
      };
    }
  // Context warning (Dec 2025): Alert user when approaching context limit
  | {
      type: 'context_warning';
      data: {
        percentUsed: number;
        estimatedTokens: number;
        contextWindow: number;
      };
    }
  // Auto-compaction event (Dec 2025): Notify when older messages are summarized
  | {
      type: 'context_compacted';
      data: {
        beforeTokens: number;
        afterTokens: number;
        messagesSummarized: number;
        findingsPreserved: number;
        techniquesPreserved: number;
        approachesPreserved: number;
        credentialsPreserved: number;
        openStepsPreserved: number;
        discoveriesPreserved: number;
        constraintsPreserved: number;
        compactionVersion: number;
      };
    }
  // Credits Events
  | {
      type: 'credits_exhausted';
      data: {
        sessionId: string;
        creditsRemaining: number;
        periodResetAt: number;
        planSlug: string;
        upgradeUrl: string;
      };
    }
  | {
      type: 'credits_low';
      data: {
        sessionId: string;
        creditsRemaining: number;
        percentRemaining: number;
        periodResetAt: number;
      };
    }
  // Token Limit Events (per-session/per-user guardrails)
  | {
      type: 'token_limit_exceeded';
      data: {
        sessionId: string;
        limitType: 'session' | 'daily';
        currentUsage: number;
        limit: number;
        usagePct: number;
        message?: string;
      };
    }
  // Session Status Events (FSM transitions)
  | {
      type: 'session.status';
      data: {
        id: string;
        status: string; // SIMPLIFIED: was SessionStatus
        previousStatus: string; // SIMPLIFIED: was SessionStatus
        blocked_reason?: string | null;
        pause_reason?: 'manual' | 'approval' | 'credits' | 'runner' | 'system' | null;
        interaction_type?: 'none';
        reason?: string;
        version: number;
        updatedAt: number;
        turnId?: string;
        mode?: 'interactive' | 'automated';
      };
    };
// REMOVED Dec 2025: session_archived, session_restored events - archive feature unused
