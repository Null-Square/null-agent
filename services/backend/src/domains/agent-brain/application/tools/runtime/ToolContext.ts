import { type SandboxAdapter } from '../../../adapters/sandbox';
import { type SessionTraceRecorder } from '../../../infrastructure/telemetry';
import { type CheckpointManager } from '../../core/CheckpointManager';
import { type SessionStore } from '../../core/SessionStore';
import { type StreamBroker } from '../../core/StreamBroker';
import { type ToolMeta, type ToolResult } from './Tool';
import { type PathGuard, type CmdGuard } from './Guards';
import { type PlanRuntime } from './PlanRuntime';
import type { SessionFlags } from '../../../domain/types';
import type { ResolvedConfig } from '@/config/configTypes';
import type {
  ContinueWorkerInput,
  SpawnWorkerInput,
  StopWorkerInput,
  WaitForWorkerInput,
  WorkerTaskOperationResult,
} from '../../services/WorkerDelegationService';
import type { ToolBudgetSnapshot } from '../../../domain/workers/workerContracts';
import type { TurnExecutorPort } from '../../../ports';

export interface ToolApprovals {
  require(input: { tool: string; preview?: Record<string, unknown> }): Promise<void>;
}

export interface ToolGuards {
  pathGuard: PathGuard;
  cmdGuard: CmdGuard;
}

export interface ToolPolicies {
  requireApproval: boolean;
  allowlist?: string[];
  denyPatterns?: RegExp[];
  maxStdoutBytes: number;
  timeoutMs: number;
}

export interface ToolWorkerDelegation {
  spawnWorker(input: SpawnWorkerInput): Promise<WorkerTaskOperationResult>;
  continueWorker(input: ContinueWorkerInput): Promise<WorkerTaskOperationResult>;
  stopWorker(input: StopWorkerInput): Promise<WorkerTaskOperationResult>;
  waitForWorker(input: WaitForWorkerInput): Promise<WorkerTaskOperationResult>;
  syncWorkerTasks(parentSessionId: string): Promise<WorkerTaskOperationResult['task'][]>;
}

export interface ToolContext {
  sessionId: string;
  /** The scope this session runs under, when it has one. Carries the customer's
   *  rules of engagement to the tools that actually touch the target. */
  scopeId?: string;
  toolCallId?: string;
  turnNumber?: number;
  workspaceDir: string;
  sandbox: SandboxAdapter;
  sessionStore: SessionStore;
  streamBroker: StreamBroker;
  trace: SessionTraceRecorder | undefined;
  approvals: ToolApprovals;
  checkpoints: CheckpointManager | undefined;
  guards: ToolGuards;
  policies: ToolPolicies;
  flags: Readonly<SessionFlags>;
  planRuntime: PlanRuntime;
  workers?: ToolWorkerDelegation;
  budget?: ToolBudgetSnapshot;
  abortSignal: AbortSignal;
  emitPartial?: (chunk: string) => void;
  recordResult?: (meta: ToolMeta, result: ToolResult) => Promise<void>;
  executeModelCall?: TurnExecutorPort['executeModelCall'];
  config?: ResolvedConfig;
}
