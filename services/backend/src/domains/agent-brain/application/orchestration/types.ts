import type OpenAI from 'openai';
import type { SessionStore } from '../core/SessionStore';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { StreamBroker } from './streaming/StreamBroker';
import type { ModelStream } from './streaming/ModelStream';
import type { UsageTrackerPort, UsageStorePort, NotificationPort, SessionEventPublisher, ToolRegistryPort } from '../../ports';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { TurnMetricsPayload } from './execution/TurnMetricsAccumulator';
import type { CheckpointMetadata } from '../../domain/types';

import type { ModelRequestPort } from '../../ports';
import type { TokenGuard } from '../services/TokenGuard';
import type { WorkContinuationGuard } from './services/WorkContinuationGuard';
import type { RuntimeHostCapabilities } from '../../domain/runtime/RuntimeHostCapabilities';
import type { ContextMeasurementHints } from '../../domain/context';

export interface TurnRunnerDeps {
  model: ModelStream | null;
  toolsRegistry: ToolRegistryPort;
  sessionStore: SessionStore;
  events?: SessionEventPublisher;
  maxToolCalls: number;
  modelName: string;
  usageTracker?: UsageTrackerPort;
  usageStore?: UsageStorePort;
  notificationPort?: NotificationPort;
  checkpointManager?: {
    create: (sessionId: string) => Promise<CheckpointMetadata>;
  };
  checkpointIntervalToolCalls?: number;
  tracesS3?: { client: S3StorageService; bucket: string };
  traceRoot?: string;
  tokenGuard?: TokenGuard;
  modelRequestPort?: ModelRequestPort;
  runtimeHostCapabilities?: RuntimeHostCapabilities;
  /** Per-turn timeout in milliseconds (0 = disabled) */
  turnTimeoutMs?: number;
  /** Session repository for durable blocked_reason persistence */
  sessionRepository?: {
    setBlockedReason: (id: string, reason: string, meta?: Record<string, unknown>, executionClaimToken?: string) => Promise<boolean>;
    getBlockedReason?: (id: string) => Promise<string | null>;
    setCompleted?: (id: string, completed: boolean, executionClaimToken?: string) => Promise<boolean>;
    touchLastActive?: (id: string, timestamp?: Date) => Promise<void>;
  };
  workContinuationGuard?: WorkContinuationGuard;
}

export interface TurnRunArgs {
  sessionId: string;
  turnNumber: number;
  abortSignal: AbortSignal;
  systemMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  historyMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolDefinitions: OpenAI.Chat.Completions.ChatCompletionTool[];
  contextMeasurementHints?: ContextMeasurementHints;
  transformationRefs?: string[];
  stream: StreamBroker;
  recorder?: SessionTraceRecorder;
  modelName?: string;
  maxToolCalls?: number;
  /** Lightweight active-turn heartbeat writer. */
  heartbeat?: () => Promise<void>;
  executionClaimToken?: string;
}

export type TurnRunStatus =
  | 'completed'
  | 'max_tool_calls'
  | 'deadlock'
  | 'awaiting_approval'
  | 'credits_exhausted'
  | 'aborted'
  | 'paused'
  | 'timeout';

export interface TurnRunResult {
  status: TurnRunStatus;
  toolCallCount: number;
  toolCallsRequested: number;
  messagesLength: number;
  doneEmitted: boolean;
  /** Token usage from this turn's model call(s) */
  usage?: {
    promptTokens: number;
    promptTokensDetails?: { cachedTokens?: number };
    completionTokens: number;
    totalTokens: number;
  };
  /** Aggregated turn metrics for wide event emission */
  metrics?: TurnMetricsPayload;
}

// Note: ModelChunk is exported from @/domains/agent-brain/ports - import directly when needed
