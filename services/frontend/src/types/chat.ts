// features/ai-chat/types.ts

import type { ReactNode } from "react";
import type {
  TaskSummary,
  TimelineEntry as ContractTimelineEntry,
  TimelineEntryImportance,
  TimelineEntryKind,
  TimelineEntrySource,
  TimelineEntryStatus,
  DesiredSessionExecution,
  SessionExecutionCondition,
} from "@null-ai/contracts";

export interface AIChatMessage {
  id: string;
  content: string;
  role: "user" | "assistant" | "tool" | "system";
  timestamp: Date;
  status?: "sending" | "sent" | "error";
  metadata?: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
}

/** A message as the session snapshot carries it (GET /api/ai-agent/sessions/{id}): timestamp in epoch ms. */
export type SessionSnapshotMessage = Omit<AIChatMessage, "timestamp"> & {
  timestamp: number;
  createdAt?: string;
};

export type PlanItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "error";

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  notes?: string;
  blockedReason?: string;
  startedAt?: number;
  completedAt?: number;
  lastTool?: string;
  outputSnippet?: string;
  artifactLinks?: string[];
  checkpointId?: string;
  mission?: MissionEnvelope;
}

export type ToolStreamStatus = "idle" | "running" | "completed" | "error";

export interface ToolStreamState {
  name: string;
  chunks: string[];
  status: ToolStreamStatus;
  command?: string;
  result?: {
    success?: boolean;
    code?: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
  };
  lastUpdated: number;
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
  args?: Record<string, unknown>;
  preview?: ApprovalPreview;
  expiresAt?: string;
  requestedAt?: number;
  reason?: string;
}

export type TimelineEntry = ContractTimelineEntry;
export type TimelineEntryStatusType = TimelineEntryStatus;
export type TimelineEntryKindType = TimelineEntryKind;
export type TimelineEntrySourceType = TimelineEntrySource;
export type TimelineEntryImportanceType = TimelineEntryImportance;
export type ActivityEntry = TimelineEntry;

export interface AIChatConfig {
  title?: string;
  subtitle?: string;
  placeholder?: string;
  buttonText?: string;
  conversationPlaceholder?: string;
  usage?: {
    contextWindow?: number;
    contextRemaining?: number;
    tokensUsed?: number;
  };
}

export type AIChatMessageInput = Omit<AIChatMessage, "timestamp" | "id"> & {
  id?: string;
  timestamp?: Date;
};

// Task types - re-exported from @null-ai/contracts (single source of truth)
export type {
  TaskInputType,
  TaskInputComponent,
  TaskInputValueType,
  TaskInputFormat,
  TaskInputOption,
  TaskInputDefinition,
  TaskSummary,
} from "@null-ai/contracts";

export interface CapabilityResolverAction {
  label: string;
  flow: string;
}

export interface CapabilityPreviewCopy {
  short?: string;
  actions?: CapabilityResolverAction[];
}

export interface CapabilityResolver {
  tool: string;
  uiFlow: string;
  argsSchema?: Record<string, unknown>;
  setsFlags?: Record<string, unknown>;
  auditRedact?: string[];
}

export interface CapabilityProbe {
  tool: string;
  args?: Record<string, unknown>;
}

export interface CapabilityManifest {
  id: string;
  title: string;
  scope: "session" | "org";
  ttl?: string;
  allowSkip?: boolean;
  dependencies?: string[];
  resolver: CapabilityResolver;
  probe?: CapabilityProbe;
  previewCopy?: CapabilityPreviewCopy;
}

export type SandboxPolicyNetwork =
  | "none"
  | "bridge"
  | "host"
  | `container:${string}`;

export interface SandboxPolicy {
  profile: string;
  privileged: boolean;
  capDrop: string[];
  capAdd: string[];
  readonlyRootfs: boolean;
  network: SandboxPolicyNetwork;
  seccomp?: string | null;
}

export interface AIChatContextType {
  messages: AIChatMessage[];
  config: AIChatConfig;
  isLoading: boolean;
  sessionId: string;
  readOnlySession?: boolean;
  sessionMode: "interactive" | "automated" | null;
  runStatus?: string | null;
  workbenchHeaderSlot?: ReactNode;
  sessionStatus:
    | "idle"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "error";
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  conditionReason?: string | null;
  pauseReason?:
    | "manual"
    | "approval"
    | "credits"
    | "runner"
    | "system"
    | null;
  interactionType?: "none";
  blockedReason?: string | null;
  isAborting: boolean;
  sandboxPolicy?: SandboxPolicy;
  plan: PlanItem[];
  toolStreams: Record<string, ToolStreamState>;
  artifacts?: SessionArtifact[];
  timeline: TimelineEntry[];
  activity: ActivityEntry[];
  task?: TaskSummary;
  streamConnected?: boolean;
  lastStreamActivityAt?: number;
  lastStreamPingAt?: number;
  executionTarget?: "cloud" | "scope_runner";
  runnerId?: string | null;
  runnerName?: string | null;
  coordination?: SessionCoordination;
  workerTasks?: WorkerTaskRecord[];
  workerResult?: WorkerResultArtifact;
  pendingApproval?: ApprovalRequest | null;
  starterPrompt?: string;
  addMessage: (message: AIChatMessageInput) => string;
  sendPrompt: (prompt: string) => Promise<void>;
  abortTurn: () => Promise<void>;
  clearMessages: () => Promise<string>;
  approvePendingAction: (actionId: string) => Promise<void>;
  denyPendingAction: (actionId: string, reason?: string) => Promise<void>;
  toastMessage?: string;
  clearToast: () => void;
}

export interface SessionArtifact {
  id: string;
  filePath: string;
  originalName: string;
  fileType?: string;
  mimeType?: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl?: string;
  storage?: "local" | "s3";
  bucket?: string;
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastTurnInputTokens?: number;
  estimatedTokens?: number;
  maxHistoryTokens?: number;
  cost?: number;
  currency?: string;
  model?: string;
  cachedPromptTokens?: number;
  platformCost?: number;
  platformPrice?: number;
  credits?: number;
  contextWindow?: number | null;
  contextRemaining?: number | null;
}

export interface SessionUsageHistoryEntry {
  ts?: number;
  turn?: number | null;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
}

export type WorkerType =
  | "recon_worker"
  | "enumeration_worker"
  | "validator_worker"
  | "attack_worker"
  | "evidence_worker"
  | "repo_research_worker"
  | "compliance_control_worker";

export type LegacyWorkerType = "exploit_worker" | "report_writer_worker";

export type AnyWorkerType = WorkerType | LegacyWorkerType;

export type WorkerTaskStatus =
  | "pending"
  | "running"
  | "blocked"
  | "awaiting_input"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkerRunMode = "blocking" | "background";
export type WorkerContinuationMode = "spawn" | "continue";
export type WorkerDependencyMode = "dependency" | "sidecar";

export interface WorkerTaskBudget {
  maxToolCalls?: number;
  maxTurns?: number;
  maxTargetRequests?: number;
  maxRequestConcurrency?: number;
  maxWallSeconds?: number;
  maxArtifactFiles?: number;
  maxArtifactBytes?: number;
  maxLeads?: number;
  maxStateChanges?: number;
}

export interface EnumerationMissionV1 {
  schemaVersion: 1;
  kind: "enumeration_hunt_v1";
  phaseAttemptId: string;
  targetRef: string;
  surface: {
    kind:
      | "endpoint_set"
      | "api_operation_set"
      | "path_prefix_set"
      | "component"
      | "client_bundle_set"
      | "repository_path_set";
    refs: string[];
  };
  techniqueIds: string[];
  primarySkill: { slug: string; versionHash: string };
  supportingSkills: Array<{ slug: string; versionHash: string }>;
  personaRefs: string[];
  sourceMode: "blackbox" | "greybox" | "whitebox";
  impactCeiling: "non_destructive" | "poc";
  budgets: Required<Omit<WorkerTaskBudget, "maxTurns">>;
  stop: {
    whenTechniquesExhausted: true;
    whenBlockedByPolicy: true;
    maxHighConfidenceLeads: number;
  };
  missionFingerprint: string;
}

export interface MissionEnvelope {
  phase?: string;
  question: string;
  whyReadyNow: string;
  requiredEvidence: string[];
  expectedArtifact: string;
  stopCondition: string;
  assignedSkills?: string[];
  parallelSafeWith?: string[];
  enumeration?: EnumerationMissionV1;
  attack?: AttackMissionV1;
}

export type AttackObjectiveFamily =
  | "demonstrate_command_execution"
  | "demonstrate_authorization_bypass"
  | "demonstrate_account_takeover"
  | "demonstrate_sensitive_data_access"
  | "demonstrate_ssrf_reachability"
  | "demonstrate_privilege_change";

export interface AttackMissionV1 {
  schemaVersion: 1;
  kind: "controlled_exploitation_v1";
  objectiveFamily: AttackObjectiveFamily;
  objective: string;
  validatedFindingIds: string[];
  targetRef: string;
  boundedPaths?: string[];
  allowedImpact: string[];
  requestBudget: number;
  toolBudget: number;
  timeBudgetSeconds: number;
  maxRequestConcurrency: number;
  requiredProof: string[];
  stopConditions: string[];
  cleanupPlan: string[];
}

export interface AttackResultV1 {
  schemaVersion: 1;
  missionId: string;
  validatedFindingIds: string[];
  targetRef: string;
  objectiveFamily: AttackObjectiveFamily;
  status:
    | "impact_demonstrated"
    | "not_demonstrated"
    | "inconclusive"
    | "denied"
    | "cancelled"
    | "failed"
    | "cleanup_failed";
  attempts: Array<{
    sequence: number;
    action: string;
    status: "completed" | "blocked" | "failed";
    evidenceIds: string[];
    changedState: boolean;
  }>;
  proofClaim: string;
  evidenceIds: string[];
  changedStateSummary: string | null;
  cleanup: {
    required: boolean;
    status: "not_required" | "completed" | "failed" | "unknown";
    actions: string[];
    evidenceIds: string[];
    remainingRisk: string | null;
  };
  limitations: string[];
  policySnapshot: Record<string, unknown>;
}

export interface EnumerationWorkerResultV1 {
  schemaVersion: 1;
  missionFingerprint: string;
  resultHash: string;
  status: "completed" | "partial" | "blocked" | "failed";
  targetRef: string;
  surfaceRefs: string[];
  skills: Array<{
    slug: string;
    versionHash: string;
    role: "primary" | "supporting";
  }>;
  leads: Array<{
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
    evidenceState: "durable" | "needs_evidence";
    confidence: number;
    priority: "low" | "medium" | "high";
    authContextClass: string;
    attemptFingerprints: string[];
  }>;
  negativeResults: Array<Record<string, unknown> & { localId: string; conclusion: string }>;
  attempts: Array<Record<string, unknown> & { fingerprint: string; requestCount: number; status: string }>;
  coverage: {
    requested: { surfaceRefs: string[]; techniqueIds: string[]; personaClasses: string[] };
    attempted: { surfaceRefs: string[]; techniqueIds: string[]; personaClasses: string[] };
    counts: { attempts: number; requests: number; leads: number; negativeResults: number };
    uncovered: Array<{ kind: string; ref: string; reason: string }>;
  };
  blockers: Array<{ code: string; message: string }>;
  artifacts: Array<{ id: string; path: string; sha256: string; bytes: number; purpose: string }>;
  recommendedValidationMissions: Array<Record<string, unknown>>;
}

export interface EnumerationDispositionRecordV1 {
  action: "disposition" | "acknowledge_terminal";
  resultHash?: string;
  terminalStateVersion?: string;
  payloadHash: string;
  completedAt: number;
  leadDispositions: Array<{
    leadLocalId: string;
    action: "accept" | "merge_duplicate" | "defer" | "reject";
    existingLeadId?: string;
    reason?: string;
    nextPrerequisite?: string;
  }>;
  canonicalLeadIds: string[];
  validatorEligibleLeadIds: string[];
  coverageAcknowledged: boolean;
  negativeResultsAcknowledged: boolean;
  terminalReason?: string;
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

export interface WorkerTaskRecord {
  taskId: string;
  parentSessionId: string;
  workerSessionId: string;
  workerType: AnyWorkerType;
  status: WorkerTaskStatus;
  reason: string;
  task: string;
  expectedArtifactType: string;
  executionMode: WorkerRunMode;
  dependencyMode?: WorkerDependencyMode;
  continuationMode: WorkerContinuationMode;
  writeScope?: string[];
  budget?: WorkerTaskBudget;
  planStepId?: string;
  mission?: MissionEnvelope;
  continuationCount?: number;
  retryIndex?: number;
  targetRequestsUsed?: number;
  enumerationAttempts?: EnumerationServerAttemptRecordV1[];
  deadlineAt?: number;
  enumerationCapability?: {
    enabled: boolean;
    cohort: "disabled" | "allowlist" | "percentage" | "benchmark";
    policyVersion: number;
    catalogVersion: string;
  };
  enumerationCreditReservation?: {
    estimatedWorkerCredits: number;
    reservedRootCredits: number;
    remainingCreditsAtAdmission: number;
    reservedAt: number;
    releasedAt?: number;
    releaseReason?: string;
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
  attackDisposition?: {
    action: "disposition" | "acknowledge_denied";
    resultStatus?: AttackResultV1["status"];
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
  status: "reserved" | "completed" | "failed";
}

export type SessionCoordinationRole = "direct" | "worker";

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
  maxTurns?: number;
  maxTargetRequests?: number;
  targetRequestsUsed?: number;
  maxRequestConcurrency?: number;
  activeTargetRequests?: number;
  enumerationMissionReservations?: Record<string, {
    taskId: string;
    reservedAt: number;
  }>;
  enumerationCreditReservations?: Record<string, {
    estimatedWorkerCredits: number;
    reservedRootCredits: number;
    remainingCreditsAtAdmission: number;
    reservedAt: number;
  }>;
  enumerationAttemptReservations?: Record<string, EnumerationServerAttemptRecordV1>;
  enumerationAttempts?: EnumerationServerAttemptRecordV1[];
  deadlineAt?: number;
}

export interface ChatSessionMeta {
  id: string;
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  conditionReason?: string | null;
  title?: string;
  status?: "idle" | "running" | "paused" | "completed" | "failed" | "error";
  version?: number;
  pause_reason?:
    | "manual"
    | "approval"
    | "credits"
    | "runner"
    | "system"
    | null;
  interaction_type?: "none";
  /** Blocked reason from backend: 'user_paused' | 'credits_exhausted' | 'awaiting_user' | 'aborted_by_user' | etc. */
  blocked_reason?: string | null;
  blocked_meta?: Record<string, unknown> | null;
  /** Whether the session is actively processing (from backend in-memory state) */
  isProcessing?: boolean;
  /** Whether the session has completed with a report.md (for notification deduplication) */
  completed?: boolean;
  mode?: "interactive" | "automated";
  createdAt: number | string;
  lastActive?: number | string;
  updatedAt: number | string;
  messageCount?: number;
  summary?: string | null;
  report?: string | null;
  artifacts?: SessionArtifact[];
  usage?: SessionUsage | null;
  usageHistory?: SessionUsageHistoryEntry[];
  executionTarget?: "cloud" | "scope_runner";
  runnerId?: string | null;
  runnerName?: string | null;
  coordination?: SessionCoordination;
  workerTasks?: WorkerTaskRecord[];
  workerResult?: WorkerResultArtifact;
  pendingApproval?: ApprovalRequest | null;
}

export interface AssistantChatSessionMeta extends ChatSessionMeta {
  scopeId?: string | null;
  assistantMode?: "read_only_chat";
  sessionKind?: "assistant_chat";
}

export interface ChatSessionSnapshot extends ChatSessionMeta {
  turn?: number;
  messages?: SessionSnapshotMessage[];
  plan?: PlanItem[];
  task?: TaskSummary;
  liveToolStreams?: Record<string, ToolStreamState>;
  timeline?: TimelineEntry[];
  coordination?: SessionCoordination;
  workerTasks?: WorkerTaskRecord[];
  workerResult?: WorkerResultArtifact;
}

