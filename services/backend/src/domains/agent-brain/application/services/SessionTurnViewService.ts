import type {
  CanonicalTraceEvent,
  TraceEventKind,
  TraceEventSeverity,
  TraceToolOutcome,
} from '@/domains/agent-brain/domain/traces/events';
import { getProviderReasoningFromMetadata } from '@/domains/agent-brain/domain/reasoning/providerReasoning';

export type SessionTurnMessage = {
  id: string;
  role: string;
  content: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | number | Date | null;
};

export type SessionTurnCostEntry = {
  turn: number | null;
  timestamp: string;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  nativeCost: number;
  overhead: number;
  platformCost: number;
  platformPrice: number;
  credits: number;
  currency: string;
  model?: string;
};

export type SessionTurnTimelineEvent = {
  id?: string;
  sessionId?: string;
  parentEventId?: string | null;
  turn?: number;
  ts?: string | number | null;
  event?: string;
  severity?: string;
  payload?: unknown;
  note?: string;
  links?: Record<string, string>;
};

export type SessionTurnToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: TraceToolOutcome;
  outcomeReason?: string;
  startedAt?: string | number | null;
  completedAt?: string | number | null;
  durationMs?: number;
  source: 'message' | 'trace' | 'message+trace';
};

export type SessionTurnLlmCall = {
  id: string;
  provider?: string;
  model?: string;
  startedAt?: string | number | null;
  completedAt?: string | number | null;
  durationMs?: number;
  finishReason?: string;
  toolCalls: number;
  assistantPreview?: string;
  reasoning?: string;
  reasoningTokens?: number;
  tokens?: {
    promptTokens?: number;
    cachedPromptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
};

export type SessionTurnReasoning = {
  id: string;
  model?: string;
  text: string;
  tokens?: number;
  source: 'message' | 'trace';
};

export type SessionTurnError = {
  id: string;
  category: string;
  message: string;
  ts?: string | number | null;
  causedBy?: string;
};

export type SessionTurn = {
  turn: number;
  startedAt?: string | number | null;
  endedAt?: string | number | null;
  summary: {
    title: string;
    model?: string;
    durationMs?: number;
    toolCalls: number;
    errors: number;
    credits?: number;
    platformPrice?: number;
    totalTokens?: number;
    finishReason?: string;
  };
  messages: SessionTurnMessage[];
  reasoning: SessionTurnReasoning[];
  llmCalls: SessionTurnLlmCall[];
  toolCalls: SessionTurnToolCall[];
  errors: SessionTurnError[];
  events: CanonicalTraceEvent[];
  cost?: SessionTurnCostEntry;
};

export type SessionTurnsResponse = {
  turns: SessionTurn[];
  summary: {
    turns: number;
    messages: number;
    llmCalls: number;
    toolCalls: number;
    errors: number;
    credits: number;
    platformPrice: number;
    totalTokens: number;
  };
  sources: {
    messages: number;
    events: number;
    costs: number;
  };
};

type BuildInput = {
  sessionId: string;
  messages: SessionTurnMessage[];
  events: SessionTurnTimelineEvent[];
  costs: SessionTurnCostEntry[];
};

type MutableTurn = {
  turn: number;
  messages: SessionTurnMessage[];
  reasoning: SessionTurnReasoning[];
  llmCalls: SessionTurnLlmCall[];
  toolCalls: SessionTurnToolCall[];
  errors: SessionTurnError[];
  events: CanonicalTraceEvent[];
  cost?: SessionTurnCostEntry;
};

type ParsedToolCall = {
  id?: string;
  name?: string;
  args: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toIso = (value: string | number | Date | null | undefined): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const compareByTime = (
  a?: string | number | Date | null,
  b?: string | number | Date | null,
): number => {
  const aTime = toIso(a);
  const bTime = toIso(b);
  return new Date(aTime ?? 0).getTime() - new Date(bTime ?? 0).getTime();
};

const normalizeSeverity = (value: unknown): TraceEventSeverity => {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  if (raw === 'critical' || raw === 'fatal') return 'critical';
  if (raw === 'error') return 'error';
  if (raw === 'warn' || raw === 'warning') return 'warn';
  return 'info';
};

const inferKind = (event: string): TraceEventKind => {
  if (event.startsWith('model.call')) return 'llm.call';
  if (event.startsWith('tool.') || event === 'action.summary') return 'tool.call';
  if (event.includes('reasoning')) return 'reasoning';
  if (event.startsWith('plan.') || event === 'submit_plan') return 'plan';
  if (event.startsWith('phase.') || event.includes('handoff')) return 'phase';
  if (event.startsWith('memory.')) return 'memory';
  if (event.startsWith('finding') || event === 'discovery') return 'finding';
  if (event === 'error' || event.endsWith('.error')) return 'error';
  if (event.startsWith('session.') || event.includes('state')) return 'state';
  return 'event';
};

const parseMaybeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const normalizeArgs = (value: unknown): Record<string, unknown> => {
  const parsed = parseMaybeJson(value);
  if (isRecord(parsed)) return parsed;
  if (parsed === undefined || parsed === null || parsed === '') return {};
  return { raw: parsed };
};

const readPayload = (event: SessionTurnTimelineEvent): Record<string, unknown> =>
  isRecord(event.payload) ? event.payload : {};

const readTokens = (value: unknown): SessionTurnLlmCall['tokens'] | undefined => {
  if (!isRecord(value)) return undefined;
  const promptTokens = asNumber(value.input) ?? asNumber(value.promptTokens);
  const cachedPromptTokens = asNumber(value.cached) ?? asNumber(value.cachedPromptTokens);
  const completionTokens = asNumber(value.output) ?? asNumber(value.completionTokens);
  const reasoningTokens = asNumber(value.reasoning) ?? asNumber(value.reasoningTokens);
  const totalTokens = asNumber(value.total) ?? asNumber(value.totalTokens);
  if (
    promptTokens === undefined &&
    cachedPromptTokens === undefined &&
    completionTokens === undefined &&
    reasoningTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return { promptTokens, cachedPromptTokens, completionTokens, reasoningTokens, totalTokens };
};

const extractReasoningText = (metadata?: Record<string, unknown> | null): string | undefined => {
  if (!metadata) return undefined;
  const providerReasoning = getProviderReasoningFromMetadata(metadata);
  if (providerReasoning?.content.trim()) return providerReasoning.content;
  for (const key of ['thinking', 'reasoning_content', 'reasoning']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const blocks = metadata.thinking_blocks;
  if (Array.isArray(blocks)) {
    const text = blocks
      .map((block) => (isRecord(block) && typeof block.thinking === 'string' ? block.thinking : ''))
      .filter(Boolean)
      .join('\n\n');
    return text || undefined;
  }
  return undefined;
};

const extractReasoningModel = (metadata?: Record<string, unknown> | null): string | undefined => {
  if (!metadata) return undefined;
  return getProviderReasoningFromMetadata(metadata)?.model ?? asString(metadata.model);
};

const parseToolCallsFromMessage = (message: SessionTurnMessage): ParsedToolCall[] => {
  const metadata = message.metadata ?? {};
  const calls: unknown[] = [];

  const fromMeta = metadata.toolCalls ?? metadata.tool_calls;
  if (Array.isArray(fromMeta)) {
    calls.push(...fromMeta);
  }

  if (message.content) {
    const parsed = parseMaybeJson(message.content);
    if (isRecord(parsed) && Array.isArray(parsed.tool_calls)) {
      calls.push(...parsed.tool_calls);
    }
  }

  return calls
    .map((raw): ParsedToolCall | null => {
      if (!isRecord(raw)) return null;
      if (isRecord(raw.function)) {
        return {
          id: asString(raw.id),
          name: asString(raw.function.name),
          args: normalizeArgs(raw.function.arguments),
        };
      }
      const directName = asString(raw.name);
      if (directName) {
        return {
          id: asString(raw.id),
          name: directName,
          args: normalizeArgs(raw.input ?? raw.arguments),
        };
      }
      return null;
    })
    .filter((call): call is ParsedToolCall => Boolean(call?.name));
};

const detectToolOutcome = (
  result: unknown,
  metadata?: Record<string, unknown> | null,
): TraceToolOutcome => {
  const status = typeof metadata?.status === 'string' ? metadata.status.toLowerCase() : '';
  if (status === 'ok' || status === 'success' || status === 'completed') return 'ok';
  if (status === 'blocked' || status === 'denied') return 'blocked';
  if (status === 'timeout') return 'timeout';
  if (status === 'error' || status === 'failed' || status === 'failure') return 'error';

  const parsed = parseMaybeJson(result);
  if (isRecord(parsed)) {
    if (parsed.forbidden === true || parsed.denied === true) return 'blocked';
    if (parsed.timeout === true) return 'timeout';
    if (parsed.success === false || parsed.ok === false || 'error' in parsed) return 'error';
  }
  if (typeof result === 'string') {
    const lowered = result.toLowerCase();
    if (lowered.startsWith('error:') || lowered.includes('"error":')) return 'error';
    if (lowered.includes('blocked') || lowered.includes('denied')) return 'blocked';
    if (lowered.includes('timeout')) return 'timeout';
  }
  return 'ok';
};

const extractErrorMessage = (value: unknown, metadata?: Record<string, unknown> | null): string | undefined => {
  for (const key of ['error', 'errorMessage', 'message']) {
    const candidate = metadata?.[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  const parsed = parseMaybeJson(value);
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (isRecord(error) && typeof error.message === 'string') return error.message;
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.reason === 'string') return parsed.reason;
  }
  return undefined;
};

const toCanonicalEvent = (event: SessionTurnTimelineEvent, sessionId: string): CanonicalTraceEvent => {
  const payload = readPayload(event);
  const name = String(event.event || payload.event || 'event');
  const ts = event.ts || new Date().toISOString();
  return {
    id: event.id || `${sessionId}-${event.turn ?? 0}-${name}-${String(ts)}`,
    sessionId: event.sessionId || sessionId,
    parentId: event.parentEventId ?? null,
    turn: typeof event.turn === 'number' && Number.isFinite(event.turn) ? event.turn : 0,
    ts: String(ts),
    durationMs: asNumber(payload.durationMs) ?? asNumber(payload.latencyMs),
    kind: inferKind(name),
    severity: normalizeSeverity(event.severity),
    event: name,
    title: asString(payload.title) ?? asString(payload.action) ?? asString(payload.toolName) ?? asString(payload.name),
    description: asString(payload.summary) ?? asString(payload.outcomeReason) ?? event.note,
    payload: event.payload,
    note: event.note,
    links: event.links,
  };
};

const toLlmCall = (event: CanonicalTraceEvent): SessionTurnLlmCall | null => {
  if (event.kind !== 'llm.call' || !isRecord(event.payload)) return null;
  const payload = event.payload;
  if (event.event.endsWith('.start')) {
    return {
      id: event.id,
      provider: asString(payload.provider),
      model: asString(payload.model),
      startedAt: event.ts,
      toolCalls: 0,
      tokens: readTokens(payload.estimatedTokens),
    };
  }
  if (event.event.endsWith('.finish')) {
    const reasoning = isRecord(payload.reasoning) ? payload.reasoning : undefined;
    return {
      id: event.id,
      model: asString(payload.model),
      completedAt: event.ts,
      durationMs: asNumber(payload.latencyMs) ?? event.durationMs,
      finishReason: asString(payload.finishReason),
      toolCalls: asNumber(payload.toolCalls) ?? 0,
      assistantPreview: asString(payload.assistantPreview),
      reasoningTokens: readTokens(payload.tokens)?.reasoningTokens ?? asNumber(reasoning?.tokens),
      tokens: readTokens(payload.tokens),
    };
  }
  return null;
};

const toToolCallFromEvent = (event: CanonicalTraceEvent): SessionTurnToolCall | null => {
  if (event.kind !== 'tool.call' || !isRecord(event.payload)) return null;
  const payload = event.payload;
  const name = asString(payload.toolName) ?? asString(payload.name) ?? asString(payload.tool) ?? 'tool';
  const id = asString(payload.toolCallId) ?? `${event.id}:${name}`;
  const outcome = (() => {
    const raw = asString(payload.outcome) ?? asString(payload.status);
    if (raw === 'success' || raw === 'completed' || raw === 'ok') return 'ok';
    if (raw === 'blocked' || raw === 'denied') return 'blocked';
    if (raw === 'timeout') return 'timeout';
    if (raw === 'error' || raw === 'failure' || raw === 'failed') return 'error';
    if (payload.success === false) return 'error';
    return event.event.endsWith('.start') ? 'pending' : 'ok';
  })();

  return {
    id,
    name,
    args: normalizeArgs(payload.args ?? payload.input),
    result: payload.result,
    status: outcome,
    outcomeReason: asString(payload.outcomeReason) ?? asString(payload.reason),
    startedAt: event.event.endsWith('.start') ? event.ts : undefined,
    completedAt: event.event.endsWith('.finish') || event.event === 'action.summary' ? event.ts : undefined,
    durationMs: asNumber(payload.durationMs) ?? event.durationMs,
    source: 'trace',
  };
};

const classifyErrorCategory = (event: CanonicalTraceEvent): SessionTurnError['category'] => {
  const haystack = `${event.event} ${event.description ?? ''} ${event.note ?? ''}`.toLowerCase();
  if (haystack.includes('timeout')) return 'timeout';
  if (haystack.includes('rate')) return 'rate_limit';
  if (haystack.includes('auth')) return 'auth';
  if (haystack.includes('context')) return 'context_too_large';
  if (haystack.includes('network')) return 'network';
  if (haystack.includes('policy') || haystack.includes('denied')) return 'policy_denied';
  if (event.severity === 'error' || event.severity === 'critical') return 'server_error';
  return 'unknown';
};

const inferMessageTurns = (messages: SessionTurnMessage[]): Map<string, number> => {
  const byId = new Map<string, number>();
  let currentTurn = 0;
  const sorted = [...messages].sort((a, b) => compareByTime(a.createdAt, b.createdAt));
  for (const message of sorted) {
    const metaTurn = isRecord(message.metadata) ? asNumber(message.metadata.turn) : undefined;
    if (metaTurn !== undefined) {
      currentTurn = metaTurn;
    } else if (message.role === 'user') {
      currentTurn += 1;
    } else if (currentTurn === 0) {
      currentTurn = 1;
    }
    byId.set(message.id, currentTurn);
  }
  return byId;
};

const mergeToolCall = (turn: MutableTurn, incoming: SessionTurnToolCall): void => {
  const existing = turn.toolCalls.find((call) => call.id === incoming.id);
  if (!existing) {
    turn.toolCalls.push(incoming);
    return;
  }
  existing.name = existing.name === 'tool' || existing.name === 'tool_result' ? incoming.name : existing.name;
  existing.args = Object.keys(existing.args).length === 0 ? incoming.args : existing.args;
  existing.result = existing.result ?? incoming.result;
  existing.status = pickToolOutcome(existing.status, incoming.status);
  existing.outcomeReason = existing.outcomeReason ?? incoming.outcomeReason;
  existing.startedAt = existing.startedAt ?? incoming.startedAt;
  existing.completedAt = existing.completedAt ?? incoming.completedAt;
  existing.durationMs = existing.durationMs ?? incoming.durationMs;
  existing.source = existing.source === incoming.source ? existing.source : 'message+trace';
};

const toolOutcomeRank: Record<TraceToolOutcome, number> = {
  pending: 0,
  ok: 1,
  timeout: 2,
  blocked: 3,
  error: 4,
};

const pickToolOutcome = (current: TraceToolOutcome, incoming: TraceToolOutcome): TraceToolOutcome =>
  toolOutcomeRank[incoming] > toolOutcomeRank[current] ? incoming : current;

const buildTurnSummary = (turn: MutableTurn): SessionTurn['summary'] => {
  const latestLlm = turn.llmCalls[turn.llmCalls.length - 1];
  const model = turn.cost?.model ?? latestLlm?.model;
  const title = [
    model ? `Model ${model}` : undefined,
    turn.toolCalls.length ? `${turn.toolCalls.length} tool call${turn.toolCalls.length === 1 ? '' : 's'}` : undefined,
    turn.errors.length ? `${turn.errors.length} error${turn.errors.length === 1 ? '' : 's'}` : undefined,
  ].filter(Boolean).join(' | ') || `Turn ${turn.turn}`;

  return {
    title,
    model,
    durationMs: latestLlm?.durationMs,
    toolCalls: turn.toolCalls.length,
    errors: turn.errors.length,
    credits: turn.cost?.credits,
    platformPrice: turn.cost?.platformPrice,
    totalTokens: turn.cost?.totalTokens ?? latestLlm?.tokens?.totalTokens,
    finishReason: latestLlm?.finishReason,
  };
};

export class SessionTurnViewService {
  build(input: BuildInput): SessionTurnsResponse {
    const turns = new Map<number, MutableTurn>();
    const ensureTurn = (turnNumber: number): MutableTurn => {
      const normalized = Number.isFinite(turnNumber) && turnNumber >= 0 ? turnNumber : 0;
      const existing = turns.get(normalized);
      if (existing) return existing;
      const created: MutableTurn = {
        turn: normalized,
        messages: [],
        reasoning: [],
        llmCalls: [],
        toolCalls: [],
        errors: [],
        events: [],
      };
      turns.set(normalized, created);
      return created;
    };

    const canonicalEvents = input.events.map((event) => toCanonicalEvent(event, input.sessionId));
    for (const event of canonicalEvents) {
      const turn = ensureTurn(event.turn);
      turn.events.push(event);

      const llmCall = toLlmCall(event);
      if (llmCall) {
        turn.llmCalls.push(llmCall);
      }

      const toolCall = toToolCallFromEvent(event);
      if (toolCall) {
        mergeToolCall(turn, toolCall);
      }

      if (event.kind === 'error' || event.severity === 'error' || event.severity === 'critical') {
        const payload = isRecord(event.payload) ? event.payload : {};
        turn.errors.push({
          id: event.id,
          category: classifyErrorCategory(event),
          message: asString(payload.message) ?? event.description ?? event.note ?? event.event,
          ts: event.ts,
          causedBy: asString(payload.toolCallId) ?? event.parentId ?? undefined,
        });
      }
    }

    const messageTurns = inferMessageTurns(input.messages);
    const toolCallTurnById = new Map<string, number>();
    for (const message of [...input.messages].sort((a, b) => compareByTime(a.createdAt, b.createdAt))) {
      const turnNumber = messageTurns.get(message.id) ?? 1;
      const turn = ensureTurn(turnNumber);
      turn.messages.push(message);

      if (message.role === 'assistant') {
        const reasoning = extractReasoningText(message.metadata);
        if (reasoning) {
          turn.reasoning.push({
            id: `${message.id}:reasoning`,
            model: extractReasoningModel(message.metadata),
            text: reasoning,
            tokens: asNumber(message.metadata?.reasoningTokens),
            source: 'message',
          });
        }

        for (const parsed of parseToolCallsFromMessage(message)) {
          const id = parsed.id ?? `${message.id}:${parsed.name ?? 'tool'}:${turn.toolCalls.length}`;
          toolCallTurnById.set(id, turnNumber);
          mergeToolCall(turn, {
            id,
            name: parsed.name ?? 'tool',
            args: parsed.args,
            status: 'pending',
            startedAt: toIso(message.createdAt),
            source: 'message',
          });
        }
      }

      if (message.role === 'tool') {
        const targetTurn = message.toolCallId && toolCallTurnById.has(message.toolCallId)
          ? ensureTurn(toolCallTurnById.get(message.toolCallId) ?? turnNumber)
          : turn;
        const id = message.toolCallId ?? `${message.id}:tool_result`;
        const result = parseMaybeJson(message.content);
        const status = detectToolOutcome(message.content, message.metadata);
        mergeToolCall(targetTurn, {
          id,
          name: message.toolName ?? 'tool_result',
          args: {},
          result,
          status,
          outcomeReason: status === 'ok' ? undefined : extractErrorMessage(message.content, message.metadata),
          completedAt: toIso(message.createdAt),
          source: 'message',
        });
      }
    }

    for (const cost of input.costs) {
      if (typeof cost.turn === 'number') {
        ensureTurn(cost.turn).cost = cost;
      }
    }

    const materialized = Array.from(turns.values())
      .sort((a, b) => a.turn - b.turn)
      .map((turn): SessionTurn => {
        const timestamps = [
          ...turn.messages.map((message) => message.createdAt),
          ...turn.events.map((event) => event.ts),
          turn.cost?.timestamp,
        ].filter((value): value is string | number | Date => value !== null && value !== undefined);
        const sortedTimestamps = [...timestamps].sort(compareByTime);
        return {
          turn: turn.turn,
          startedAt: toIso(sortedTimestamps[0]),
          endedAt: toIso(sortedTimestamps[sortedTimestamps.length - 1]),
          summary: buildTurnSummary(turn),
          messages: turn.messages,
          reasoning: turn.reasoning,
          llmCalls: turn.llmCalls,
          toolCalls: turn.toolCalls.sort((a, b) => compareByTime(a.startedAt ?? a.completedAt, b.startedAt ?? b.completedAt)),
          errors: turn.errors,
          events: turn.events.sort((a, b) => compareByTime(a.ts, b.ts)),
          cost: turn.cost,
        };
      });

    return {
      turns: materialized,
      summary: {
        turns: materialized.length,
        messages: input.messages.length,
        llmCalls: materialized.reduce((sum, turn) => sum + turn.llmCalls.length, 0),
        toolCalls: materialized.reduce((sum, turn) => sum + turn.toolCalls.length, 0),
        errors: materialized.reduce((sum, turn) => sum + turn.errors.length, 0),
        credits: input.costs.reduce((sum, cost) => sum + cost.credits, 0),
        platformPrice: input.costs.reduce((sum, cost) => sum + cost.platformPrice, 0),
        totalTokens: input.costs.reduce((sum, cost) => sum + cost.totalTokens, 0),
      },
      sources: {
        messages: input.messages.length,
        events: input.events.length,
        costs: input.costs.length,
      },
    };
  }
}
