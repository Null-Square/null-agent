export type TraceEventSeverity = 'info' | 'warn' | 'error' | 'critical';

export type TraceEventKind =
  | 'llm.call'
  | 'tool.call'
  | 'reasoning'
  | 'plan'
  | 'phase'
  | 'memory'
  | 'finding'
  | 'state'
  | 'error'
  | 'event';

export type TraceToolOutcome = 'ok' | 'error' | 'blocked' | 'timeout' | 'pending';

export type TraceMessageRole = 'system' | 'user' | 'assistant' | 'tool' | string;

export type TraceChatMessage = {
  id?: string;
  role: TraceMessageRole;
  content: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string | number | null;
};

export type TraceTokenUsage = {
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export interface CanonicalTraceEvent {
  id: string;
  sessionId: string;
  parentId?: string | null;
  turn: number;
  ts: string;
  durationMs?: number;
  kind: TraceEventKind;
  severity: TraceEventSeverity;
  event: string;
  title?: string;
  description?: string;
  payload?: unknown;
  note?: string;
  links?: Record<string, string>;
}

export interface LlmCallTraceEvent extends CanonicalTraceEvent {
  kind: 'llm.call';
  provider?: string;
  model?: string;
  inputMessages?: TraceChatMessage[];
  outputMessage?: TraceChatMessage | null;
  reasoning?: string;
  reasoningTokens?: number;
  tokens?: TraceTokenUsage;
  costUsd?: number;
  platformPriceUsd?: number;
  credits?: number;
  finishReason?: string;
  systemFingerprint?: string;
  storageRef?: string;
}

export interface ToolCallTraceEvent extends CanonicalTraceEvent {
  kind: 'tool.call';
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  outcome: TraceToolOutcome;
  outcomeReason?: string;
  storageRef?: string;
}

export interface ReasoningTraceEvent extends CanonicalTraceEvent {
  kind: 'reasoning';
  model?: string;
  text: string;
  tokens?: number;
}

export interface ErrorTraceEvent extends CanonicalTraceEvent {
  kind: 'error';
  category: 'timeout' | 'rate_limit' | 'auth' | 'context_too_large' | 'server_error' | 'network' | 'policy_denied' | 'unknown';
  message: string;
  stack?: string;
  causedBy?: string;
}

export type TraceEvent =
  | LlmCallTraceEvent
  | ToolCallTraceEvent
  | ReasoningTraceEvent
  | ErrorTraceEvent
  | CanonicalTraceEvent;
