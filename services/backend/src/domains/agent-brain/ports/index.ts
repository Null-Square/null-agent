/**
 * Agent Brain Ports
 * 
 * Port interfaces defining boundaries between domain and infrastructure.
 * All port files are now in this directory.
 * 
 * @module agent-brain/ports
 */

import type { ToolManifest } from '../domain/manifests';
import type {
  PlanItem,
  StreamEvent,
  ApprovalRequest,
  ToolAccessPolicy,
  ContextBlocks,
  ContextRequest,
  ToolExecutionReceiptV1,
} from '../domain/types';
import type {
  TraceEvent,
  SessionTraceSeed,
  SessionTraceCloseMeta,
  TraceWriteResult,
} from '../infrastructure/telemetry';
import type { ToolDefinition } from '../domain/types';
import type { ToolBudgetSnapshot } from '../domain/workers/workerContracts';
import type { StreamBroker as ToolCallStreamBroker } from '../application/orchestration/streaming/StreamBroker';
import type { ToolProgressKind } from '../application/tools/runtime/Tool';
import type { TurnExecutorPort } from './orchestration';

// Re-export from individual port files
export * from './ChatProviderPort';
export * from './PolicyRepositoryPort';
export * from './SessionRetentionPort';
export * from './SessionEventJournalPort';
export * from './SandboxImagePort';
export * from './ArtifactServicePort';
export * from './ToolExecutionPort';
export * from './ModelRequestPort';
export * from './HistoryTransformationPort';
export * from './NotificationPort';
export * from './SubscriptionPort';
export * from './ScopeVerificationPort';
export * from './ModelConfigPort';
export * from './UsagePort';
export * from './RetrySchedulerPort';
export * from './sandboxHealth';
export * from './sandboxProfileRegistry';
export * from './sandboxProvision';
export * from './sandboxRuntime';
export * from './sandboxTypes';
export * from './sessionRepository';
export * from './modelStream';
export * from './modelExecution';
export * from './orchestration';
export * from './workspace';
export * from './StreamPort';

// Inline interface definitions (from original core/ports/index.ts)
export interface ContextProviderPort {
  getContext(request: ContextRequest): Promise<ContextBlocks>;
  getShortRules(): Promise<ContextBlocks>;
}

export interface ToolExecutionOptions {
  sessionId: string;
  /** Immutable E4 request that produced this tool call. */
  modelRequestId?: string;
  abortSignal?: AbortSignal;
  toolCallId?: string;
  budget?: ToolBudgetSnapshot;
  turnNumber?: number;
  turnId?: string;
  rawArgsJson?: string;
  stream?: ToolCallStreamBroker;
  executeModelCall?: TurnExecutorPort['executeModelCall'];
}

export interface ToolExecutionWithReceipt {
  result: unknown;
  receipt: ToolExecutionReceiptV1;
}

export interface ToolPipelineCoverage {
  schema: 'tool-execution-pipeline/v1';
  owner: 'ToolsRegistry.executeResolvedTool';
  executableToolIds: string[];
  uncoveredToolIds: string[];
}

export interface WorkspaceProjectionFlushOptions {
  sessionId: string;
  reason: string;
  turnNumber?: number;
  scopes?: string[];
  forceModel?: boolean;
}

export interface WorkspaceProjectionFlushResult {
  flushed: boolean;
  scopes: string[];
  written: number;
  writtenPaths?: string[];
  requestedScopes?: string[];
  forceModel?: boolean;
  dirtyCount: number;
  warning?: string;
}

export interface ToolRegistryPort {
  listManifests(): Promise<ToolManifest[]>;
  getManifest(id: string): Promise<ToolManifest | undefined>;
  getToolProgressKind?(id: string): ToolProgressKind | undefined;
  getToolSchemas(): ToolDefinition[];
  /** Catalog proof that all executable modules enter the canonical E8 lifecycle. */
  getUnifiedPipelineCoverage?(): Promise<ToolPipelineCoverage>;
  execute(
    toolId: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
  ): Promise<unknown>;
  executeWithReceipt(
    toolId: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionWithReceipt>;
  handleApprovalDecision(
    sessionId: string,
    actionId: string,
    status: 'granted' | 'denied',
    reason?: string,
  ): Promise<{ handled: boolean; needsResume: boolean }>;
  flushWorkspaceProjection?(
    options: WorkspaceProjectionFlushOptions,
  ): Promise<WorkspaceProjectionFlushResult>;
  getPendingApprovals?(sessionId: string): Promise<ApprovalRequest[]>;
}

export interface PolicyProviderPort {
  getToolPolicy(sessionId: string): Promise<ToolAccessPolicy | undefined>;
  setToolPolicy(sessionId: string, policy: ToolAccessPolicy): Promise<void>;
}

export interface SecretsProviderPort {
  putSecret(sessionId: string, key: string, value: string): Promise<void>;
  getSecret(sessionId: string, key: string): Promise<string | undefined>;
  deleteSecret(sessionId: string, key: string): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

// SandboxRuntimePort is exported from ./sandboxRuntime (with correct exec signature)

// SessionRepositoryPort is exported from ./sessionRepository (with full CAS methods)

export interface TelemetryPort {
  init(sessionId: string, seed: SessionTraceSeed): Promise<void>;
  write(sessionId: string, turn: number, event: TraceEvent): Promise<TraceWriteResult>;
  close(sessionId: string, meta: SessionTraceCloseMeta): Promise<void>;
}

export interface SessionEventPublisher {
  subscribe(sessionId: string, callback: (event: StreamEvent) => void): () => void;
  emit(sessionId: string, event: StreamEvent): void;
  emitPlan(sessionId: string, plan: PlanItem[]): void;
  cleanup(sessionId: string): void;
}
