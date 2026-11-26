import { v4 as uuidv4 } from 'uuid';
import type OpenAI from 'openai';
import type { SessionStore } from '../../core/SessionStore';
import type { StreamBroker } from '../streaming/StreamBroker';
import { DeadlockDetector } from '../../services/DeadlockDetector';
import type {
  ApprovalPreview,
  Message,
  CheckpointMetadata,
  PendingApproval,
  ToolExecutionOutcome,
  ToolExecutionReceiptV1,
} from '../../../domain/types';
import type { StreamToolCall } from '../../../ports';
import type { TurnMetricsAccumulator } from './TurnMetricsAccumulator';
import type { TurnExecutorPort } from '../../../ports';
import { logger } from '@/shared/logger';
import { recordToolExec } from '@/shared/metrics/prometheusMetrics';
import { toSafeError } from '@/shared/errors';
import { sha256Hex } from '@/shared/utils/hash';
import { AttemptGuard } from './AttemptGuard';
import { MemoryManager } from '../../../domain/helpers/MemoryManager';
import { ActionSummaryEmitter } from '../../../infrastructure/telemetry/ActionSummaryEmitter';
import type {
  ActionSummaryPayload,
  DiscoveryPayload,
  MemoryUpdatePayload,
} from '../../../infrastructure/telemetry/types';
import { createAttemptKey, type AgentMemory, type FactCategory } from '../../../domain/types/memory';
import type { ToolRegistryPort } from '../../../ports';
import {
  projectToolResultForPrompt,
  type ToolResultProjectionStats,
} from '../tool-results/ToolResultStore';
import type { WorkContinuationGuard } from '../services/WorkContinuationGuard';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';

const DEADLOCK_LIMIT = 3;

export type CheckpointManagerPort = {
  create(sessionId: string): Promise<CheckpointMetadata>;
};

export type TurnToolExecutorDeps = {
  sessionStore: SessionStore;
  toolsRegistry: ToolRegistryPort;
  /** Optional checkpoint manager for auto-checkpointing */
  checkpointManager?: CheckpointManagerPort;
  /** Checkpoint interval (tool calls). 0 = disabled */
  checkpointIntervalToolCalls?: number;
  workContinuationGuard?: WorkContinuationGuard;
  executeModelCall?: TurnExecutorPort['executeModelCall'];
};

export type TurnToolExecutorArgs = {
  sessionId: string;
  /** Immutable E4 request that produced this tool batch. */
  modelRequestId?: string;
  abortSignal: AbortSignal;
  toolCalls: StreamToolCall[];
  stream: StreamBroker;
  /** Current logical turn number owned by TurnRunner. */
  turnNumber?: number;
  maxToolCalls?: number;
  reservedToolCalls?: number;
  /** Whether session is in automated mode (enables auto-checkpointing) */
  isAutomated?: boolean;
  /** Running tool call count for this session (for checkpoint calculation) */
  sessionToolCallCount?: number;
  /** Optional metrics accumulator for wide turn events */
  metricsAccumulator?: TurnMetricsAccumulator;
  traceRecorder?: SessionTraceRecorder;
};

export type TurnToolExecutorResult = {
  currentMessages: OpenAI.Chat.ChatCompletionMessageParam[];
  toolCallCount: number;
  skippedToolCalls: SkippedToolCall[];
  status?: 'deadlock' | 'awaiting_approval' | 'aborted';
  doneEmitted?: boolean;
  pendingApproval?: PendingApproval;
  awaitingApprovalContext?: {
    kind: 'plan_submission';
    runId?: string;
  };
  /**
   * Tool result messages collected during execution for atomic persistence.
   * These are NOT persisted by TurnToolExecutor - TurnRunner will batch persist them
   * together with the assistant message to prevent orphaned tool_calls.
   */
  collectedToolResults: Message[];
  /**
   * Action summaries for each executed tool (for trace observability).
   * TurnRunner will emit these as action.summary trace events.
   */
  actionSummaries: ActionSummaryPayload[];
  /**
   * Discoveries detected during tool execution (for trace observability).
   * TurnRunner will emit these as discovery trace events.
   */
  discoveries: DiscoveryPayload[];
  /**
   * Memory updates that occurred during tool execution (for trace observability).
   * TurnRunner will emit these as memory.update trace events.
   */
  memoryUpdates: MemoryUpdatePayload[];
  /**
   * Tool-result projection and persistence events for trace observability.
   * TurnRunner emits these after assistant/tool messages are persisted atomically.
   */
  toolResultEvents: ToolResultProjectionStats[];
};

export type SkippedToolCall = {
  toolCallId: string;
  toolName: string;
  reason?: string;
  endpoint?: string;
  technique?: string;
};

export class TurnToolExecutor {
  private readonly log = logger.child({ scope: 'TurnToolExecutor' });
  private readonly checkpointInterval: number;

  constructor(private readonly deps: TurnToolExecutorDeps) {
    this.checkpointInterval = deps.checkpointIntervalToolCalls ?? 0;
  }

  /**
   * Extract endpoint and technique from http_payload args
   * Returns undefined if not http_payload or if parsing fails
   */
  private extractHttpPayloadInfo(
    toolName: string,
    argsJson: string,
  ): { endpoint: string; technique: string; attemptTechnique: string } | undefined {
    if (toolName !== 'http_payload') {
      return undefined;
    }

    const args = this.parseJsonRecord(argsJson);
    if (!args) {
      return undefined;
    }

    const url =
      this.normalizeText(args.url) ||
      this.extractHttpUrlFromRawRequest(args.raw_request) ||
      this.extractHttpUrlFromRawRequest(args.rawRequest);
    if (!url) {
      return undefined;
    }

    const endpoint = this.normalizeHttpEndpoint(url);

    const explicitTechnique = this.normalizeHttpTechnique(args.technique);
    const baseTechnique = explicitTechnique ?? this.inferHttpTechnique(args);
    const attemptTechnique = this.buildHttpAttemptTechnique(baseTechnique, args);

    return { endpoint, technique: baseTechnique, attemptTechnique };
  }

  private inferHttpTechnique(args: Record<string, unknown>): string {
    const body = this.normalizeText(args.body);
    const rawRequest = this.normalizeText(args.raw_request || args.rawRequest);
    const combined = `${body} ${rawRequest}`.toLowerCase();

    if (combined.includes('union') || combined.includes('select') || /'\s*(or|and)\s+['"\d]/i.test(combined)) {
      return 'sqli';
    }
    if (combined.includes('<script') || combined.includes('javascript:') || /onerror\s*=/.test(combined)) {
      return 'xss';
    }

    return 'probe';
  }

  private buildHttpAttemptTechnique(baseTechnique: string, args: Record<string, unknown>): string {
    const signature: Record<string, unknown> = {};
    const method = this.normalizeText(args.method).toUpperCase();
    const body = this.normalizeText(args.body);
    const rawRequest = this.normalizeText(args.raw_request || args.rawRequest);

    if (method && (method !== 'GET' || body || rawRequest)) {
      signature.method = method;
    }
    if (body) {
      signature.bodyHash = this.shortHash(body);
    }
    if (rawRequest) {
      signature.rawRequestHash = this.shortHash(rawRequest);
    }
    if (args.headers !== undefined) {
      signature.headersHash = this.shortHash(this.stableStringifyForSignature(args.headers));
    }
    if (args.max_body_bytes !== undefined) {
      signature.maxBodyBytes = args.max_body_bytes;
    }
    if (args.follow_redirects !== undefined) {
      signature.followRedirects = args.follow_redirects;
    }
    if (args.timeout_ms !== undefined) {
      signature.timeoutMs = args.timeout_ms;
    }
    if (Object.keys(signature).length === 0) {
      return baseTechnique;
    }

    return `${baseTechnique}#${this.shortHash(this.stableStringifyForSignature(signature))}`;
  }

  private stableStringifyForSignature(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value !== 'object') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableStringifyForSignature(entry)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${key}:${this.stableStringifyForSignature(record[key])}`)
      .join(',')}}`;
  }

  private shortHash(value: string): string {
    return sha256Hex(value).slice(0, 12);
  }

  private extractHttpUrlFromRawRequest(rawRequest: unknown): string {
    const requestText = this.normalizeText(rawRequest);
    if (!requestText) {
      return '';
    }
    const match = requestText.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+([^\s]+)/mi);
    return match?.[2]?.trim() ?? '';
  }

  private normalizeHttpEndpoint(rawUrl: string): string {
    const normalizedUrl = this.normalizeText(rawUrl);
    if (!normalizedUrl) {
      return '';
    }

    try {
      const parsed = new URL(normalizedUrl, 'http://placeholder');
      if (parsed.hostname === 'placeholder') {
        return parsed.pathname + (parsed.search || '');
      }
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search || ''}`;
    } catch {
      return normalizedUrl;
    }
  }

  private normalizeHttpTechnique(value: unknown): string | undefined {
    const normalized = this.normalizeKey(value);
    return normalized.length > 0 ? normalized : undefined;
  }

  private extractHttpStatusCode(toolResult: unknown): number | undefined {
    const payload = this.extractToolPayload(toolResult);
    if (!payload) {
      return undefined;
    }
    const statusRaw = payload.status_code;
    if (typeof statusRaw === 'number' && Number.isFinite(statusRaw)) {
      return statusRaw;
    }
    if (typeof statusRaw === 'string') {
      const parsed = Number(statusRaw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private extractToolPayload(toolResult: unknown): Record<string, unknown> | undefined {
    if (!this.isRecord(toolResult)) {
      return undefined;
    }
    if (this.isRecord(toolResult.data)) {
      return toolResult.data;
    }
    return toolResult;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseJsonRecord(raw: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw);
      return this.isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private normalizeText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeKey(value: unknown): string {
    return this.normalizeText(value).toLowerCase();
  }

  private methodologyGateBypassAllowed(toolName: string, argsJson: string): boolean {
    if (toolName === 'file_read') {
      return true;
    }
    if (toolName !== 'plan_set_step_status') {
      return false;
    }

    const parsedArgs = this.parseJsonRecord(argsJson);
    const status = this.normalizeKey(parsedArgs?.status);
    return status === 'blocked' || status === 'error' || status === 'pending';
  }

  private getActiveMethodologyRequirement(
    session: unknown,
    toolName: string,
    argsJson: string,
  ): {
    stepId: string;
    skills: string[];
    paths: string[];
    reason: string;
  } | null {
    if (!session || this.methodologyGateBypassAllowed(toolName, argsJson) || !this.isRecord(session)) {
      return null;
    }

    const flags =
      this.isRecord(session.flags)
        ? session.flags
        : null;
    const requirement =
      flags && this.isRecord(flags.activeMethodologyRequirement)
        ? flags.activeMethodologyRequirement
        : null;
    if (!requirement) {
      return null;
    }

    const stepId = this.normalizeText(requirement.stepId);
    const skills = Array.isArray(requirement.skills)
      ? requirement.skills
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => this.normalizeKey(entry))
          .filter((entry) => entry.length > 0)
      : [];
    const paths = Array.isArray(requirement.paths)
      ? requirement.paths
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
    if (!stepId || skills.length === 0 || paths.length === 0) {
      return null;
    }

    const reason = `Active plan step ${stepId} requires methodology read before ${toolName}. Read ${paths.join(', ')} with file_read, then retry.`;

    return {
      stepId,
      skills,
      paths,
      reason,
    };
  }

  private normalizeApprovalPreview(value: unknown): ApprovalPreview | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const preview: ApprovalPreview = {};
    const cmd = this.normalizeText(value.cmd);
    const path = this.normalizeText(value.path);
    const diff = this.normalizeText(value.diff);
    const risk = Array.isArray(value.risk)
      ? value.risk
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

    if (cmd) {
      preview.cmd = cmd;
    }
    if (path) {
      preview.path = path;
    }
    if (diff) {
      preview.diff = diff;
    }
    if (risk.length > 0) {
      preview.risk = risk;
    }

    return Object.keys(preview).length > 0 ? preview : undefined;
  }

  private extractPendingApproval(
    toolName: string,
    toolResult: unknown,
    toolCallId: string,
    fallbackArgs: Record<string, unknown>,
  ): PendingApproval | null {
    if (!this.isRecord(toolResult) || toolResult.approvalRequired !== true) {
      return null;
    }

    const actionId = this.normalizeText(toolResult.actionId) || toolCallId;
    const approvalTool = this.normalizeText(toolResult.tool) || toolName;
    const normalizedToolCallId = this.normalizeText(toolResult.toolCallId) || toolCallId;
    const modelRequestId = this.normalizeText(toolResult.modelRequestId);
    const pendingArgs = this.isRecord(toolResult.args) ? toolResult.args : fallbackArgs;
    const preview = this.normalizeApprovalPreview(toolResult.preview);
    const reason = this.normalizeText(toolResult.reason);
    const requestedAt =
      typeof toolResult.requestedAt === 'number' && Number.isFinite(toolResult.requestedAt)
        ? toolResult.requestedAt
        : Date.now();

    return {
      actionId,
      tool: approvalTool,
      toolCallId: normalizedToolCallId,
      ...(modelRequestId ? { modelRequestId } : {}),
      ...(Object.keys(pendingArgs).length > 0 ? { args: pendingArgs } : {}),
      ...(preview ? { preview } : {}),
      ...(reason ? { reason } : {}),
      requestedAt,
    };
  }

  private extractAwaitingApprovalControl(
    toolResult: unknown,
  ): TurnToolExecutorResult['awaitingApprovalContext'] | null {
    if (!this.isRecord(toolResult) || !this.isRecord(toolResult.control)) {
      return null;
    }

    const control = toolResult.control;
    const controlKind = this.normalizeKey(control.kind);
    const controlReason = this.normalizeKey(control.reason);
    if (controlKind !== 'awaiting_approval' || controlReason !== 'plan_submission') {
      return null;
    }

    const runId = this.normalizeText(control.runId);
    return {
      kind: 'plan_submission',
      ...(runId ? { runId } : {}),
    };
  }

  private isToolResultOk(toolResult: unknown): boolean {
    if (!this.isRecord(toolResult)) return false;
    return toolResult.ok === true;
  }

  private recordFact(
    memory: AgentMemory,
    memoryUpdates: MemoryUpdatePayload[],
    fact: {
      category: FactCategory;
      key: string;
      value: unknown;
      confidence: number;
      source: string;
    },
  ): void {
    const factResult = MemoryManager.addFact(memory, {
      category: fact.category,
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      source: fact.source,
    });
    if (!factResult.added && !factResult.updated) {
      return;
    }

    memoryUpdates.push({
      operation: factResult.updated ? 'fact_updated' : 'fact_added',
      change: {
        type: 'fact',
        key: fact.key,
        value: fact.value,
        ...(factResult.updated ? { previousValue: factResult.previousValue } : {}),
      },
      memoryStats: factResult.stats,
    });
  }

  private classifyHttpAttemptResult(
    toolSuccess: boolean,
    toolResult: unknown,
  ): { result: 'success' | 'failed' | 'blocked'; reason?: string; shouldRecord: boolean } {
    const payload = this.extractToolPayload(toolResult);
    const statusCode = this.extractHttpStatusCode(toolResult);
    if (typeof statusCode === 'number') {
      if (statusCode === 401 || statusCode === 403) {
        return { result: 'blocked', reason: `HTTP ${statusCode} authorization barrier`, shouldRecord: true };
      }
      if (statusCode === 404) {
        return { result: 'failed', reason: 'HTTP 404', shouldRecord: false };
      }
      if (statusCode >= 400 && statusCode <= 599) {
        return { result: 'failed', reason: `HTTP ${statusCode}`, shouldRecord: true };
      }
      return { result: 'success', shouldRecord: true };
    }

    if (payload?.aborted === true) {
      return {
        result: 'blocked',
        shouldRecord: true,
        reason:
          typeof payload.abortReason === 'string' && payload.abortReason.length > 0
            ? payload.abortReason
            : 'Request aborted',
      };
    }
    if (payload?.timedOut === true) {
      return { result: 'failed', reason: 'Request timed out', shouldRecord: true };
    }
    if (payload?.success === false) {
      return {
        result: 'failed',
        shouldRecord: true,
        reason:
          typeof payload.error === 'string'
            ? payload.error
            : typeof payload.curl_error === 'string'
              ? payload.curl_error
              : 'Request failed',
      };
    }

    const resultStr = JSON.stringify(toolResult) ?? String(toolResult ?? '');
    if (!toolSuccess || resultStr.includes('error')) {
      return { result: 'failed', reason: resultStr.slice(0, 200), shouldRecord: true };
    }
    return { result: 'success', shouldRecord: true };
  }

  private buildToolExecutionReceipt(
    toolName: string,
    toolCallId: string,
    outcome: ToolExecutionOutcome,
    modelRequestId?: string,
  ): ToolExecutionReceiptV1 {
    return {
      schema: 'tool-execution-receipt/v1',
      toolName,
      toolCallId,
      ...(modelRequestId ? { modelRequestId } : {}),
      outcome,
    };
  }

  private toToolMetricOutcome(outcome: ToolExecutionOutcome): 'success' | 'failure' | 'blocked' {
    if (outcome === 'succeeded') return 'success';
    if (outcome === 'blocked' || outcome === 'skipped' || outcome === 'awaiting_approval') {
      return 'blocked';
    }
    return 'failure';
  }

  private toActionSummaryResult(toolResult: unknown, fallbackOk: boolean): {
    ok: boolean;
    message?: string;
    data?: unknown;
  } {
    if (!this.isRecord(toolResult)) {
      return {
        ok: fallbackOk,
        data: toolResult,
      };
    }

    const message =
      typeof toolResult.message === 'string'
        ? toolResult.message
        : typeof toolResult.error === 'string'
          ? toolResult.error
          : undefined;

    if ('data' in toolResult || 'ok' in toolResult) {
      return {
        ok: typeof toolResult.ok === 'boolean' ? toolResult.ok : fallbackOk,
        message,
        data: toolResult.data ?? toolResult,
      };
    }

    return {
      ok: fallbackOk,
      message,
      data: toolResult,
    };
  }

  /**
   * Check if auto-checkpoint should be created based on tool call count
   */
  private shouldAutoCheckpoint(totalToolCalls: number): boolean {
    if (this.checkpointInterval <= 0 || !this.deps.checkpointManager) {
      return false;
    }
    return totalToolCalls > 0 && totalToolCalls % this.checkpointInterval === 0;
  }

  /**
   * Create auto-checkpoint and emit SSE event
   */
  private async createAutoCheckpoint(sessionId: string, totalToolCalls: number, stream: StreamBroker): Promise<void> {
    if (!this.deps.checkpointManager) return;

    try {
      const checkpoint = await this.deps.checkpointManager.create(sessionId);
      this.log.info(
        { sessionId, checkpointId: checkpoint.id, toolCallCount: totalToolCalls },
        '[TurnToolExecutor] Auto-checkpoint created',
      );
      stream.raw('checkpoint_created', checkpoint);
    } catch (error: unknown) {
      const err = toSafeError(error);
      this.log.warn(
        { err, sessionId, toolCallCount: totalToolCalls },
        '[TurnToolExecutor] Failed to create auto-checkpoint',
      );
    }
  }

  private mergeProjectionWarning(content: string, warning: string): string {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          ...(parsed as Record<string, unknown>),
          workspaceProjectionWarning: warning,
        });
      }
      return JSON.stringify({ value: parsed, workspaceProjectionWarning: warning });
    } catch {
      return JSON.stringify({ text: content, workspaceProjectionWarning: warning });
    }
  }

  private appendProjectionWarningToLastToolResult(params: {
    warning: string;
    currentMessages: OpenAI.Chat.ChatCompletionMessageParam[];
    collectedToolResults: Message[];
  }): void {
    const lastToolResult = [...params.collectedToolResults]
      .reverse()
      .find((message) => message.role === 'tool' && typeof message.content === 'string');
    if (!lastToolResult) {
      return;
    }

    const nextContent = this.mergeProjectionWarning(lastToolResult.content, params.warning);
    lastToolResult.content = nextContent;
    const toolCallId = lastToolResult.toolCallId ?? lastToolResult.tool_call_id;
    for (let index = params.currentMessages.length - 1; index >= 0; index--) {
      const message = params.currentMessages[index] as OpenAI.Chat.ChatCompletionMessageParam & {
        tool_call_id?: string;
        content?: unknown;
      };
      if (message.role === 'tool' && (!toolCallId || message.tool_call_id === toolCallId)) {
        message.content = nextContent;
        return;
      }
    }
  }

  private async flushWorkspaceProjectionBoundary(params: {
    sessionId: string;
    turnNumber?: number;
    currentMessages: OpenAI.Chat.ChatCompletionMessageParam[];
    collectedToolResults: Message[];
  }): Promise<void> {
    const flushWorkspaceProjection = this.deps.toolsRegistry.flushWorkspaceProjection;
    if (typeof flushWorkspaceProjection !== 'function' || params.collectedToolResults.length === 0) {
      return;
    }

    const result = await flushWorkspaceProjection({
      sessionId: params.sessionId,
      turnNumber: params.turnNumber,
      reason: 'turn_boundary',
    });
    if (result.warning) {
      this.appendProjectionWarningToLastToolResult({
        warning: result.warning,
        currentMessages: params.currentMessages,
        collectedToolResults: params.collectedToolResults,
      });
    }
  }

  async run(args: TurnToolExecutorArgs): Promise<TurnToolExecutorResult> {
    const { sessionId, abortSignal, toolCalls, stream } = args;
    const workspaceDir = this.deps.sessionStore.get(sessionId)?.workspaceDir;
    const currentMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const collectedToolResults: Message[] = [];  // ATOMIC PERSISTENCE: Collect, don't persist
    const skippedToolCalls: SkippedToolCall[] = [];
    const actionSummaries: ActionSummaryPayload[] = [];  // Trace observability v2
    const discoveries: DiscoveryPayload[] = [];  // Trace observability v2
    const memoryUpdates: MemoryUpdatePayload[] = [];  // Trace observability v2
    const toolResultEvents: ToolResultProjectionStats[] = [];
    let toolCallCount = 0;

    const finish = async (result: TurnToolExecutorResult): Promise<TurnToolExecutorResult> => {
      await this.flushWorkspaceProjectionBoundary({
        sessionId,
        turnNumber: args.turnNumber,
        currentMessages,
        collectedToolResults,
      });
      return result;
    };

    // BEST PRACTICE (Dec 2025): Create fresh detector per run
    // Matches Codex/Anthropic pattern - impossible to have cross-turn state bleed
    const deadlockDetector = new DeadlockDetector(DEADLOCK_LIMIT);
    this.log.debug(
      { sessionId, toolCallsCount: toolCalls.length },
      '[TurnToolExecutor] Starting tool execution with fresh deadlock detector'
    );

    for (const toolCall of toolCalls) {
      const continuation = await this.deps.workContinuationGuard?.canContinue({
        sessionId,
        boundary: 'tool_call',
        abortSignal,
      });
      if (continuation && !continuation.ok) {
        this.log.info(
          { sessionId, tool: toolCall.function.name, continuation },
          '[TurnToolExecutor] Work continuation blocked before tool execution',
        );
        args.traceRecorder?.write?.(sessionId, args.turnNumber ?? 0, {
          event: 'session.work_blocked',
          severity: 'warn',
          payload: {
            boundary: 'tool_call',
            reason: continuation.reason,
            status: 'aborted',
            retryable: false,
            resumeAllowed: continuation.reason !== 'aborted_by_user',
            nextAction: 'resume the session if the work block has been cleared',
            source: continuation.source,
            toolName: toolCall.function.name,
          },
          note: `Work blocked before tool ${toolCall.function.name}: ${continuation.reason}`,
        }).catch((error) => {
          this.log.warn({ err: error, sessionId }, 'Failed to record tool-call work block');
        });
        return finish({
          currentMessages,
          toolCallCount,
          skippedToolCalls,
          status: 'aborted',
          collectedToolResults,
          actionSummaries,
          discoveries,
          memoryUpdates,
          toolResultEvents,
        });
      }

      if (deadlockDetector.isDeadlocked(toolCall.function.name, toolCall.function.arguments)) {
        // Repetition is a recoverable control signal, not a session stop.
        // P2 FIX (Dec 2025): Deadlock → structured stop, NOT assistant message
        // Preserve the tool-call contract without freezing the run: return a
        // skipped tool result so the model can change strategy or hand off.
        this.log.warn(
          { sessionId, tool: toolCall.function.name },
          '[TurnToolExecutor] Repeated identical tool call skipped'
        );

        const reason = 'repeated_identical_tool_call';
        skippedToolCalls.push({
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          reason,
        });

        if (args.metricsAccumulator) {
          args.metricsAccumulator.recordToolSkip();
        }

        try {
          const parsedArgs = this.parseJsonRecord(toolCall.function.arguments) ?? {};
          const summaryResult = ActionSummaryEmitter.summarize({
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            args: parsedArgs,
            result: { ok: false, message: reason },
            durationMs: 0,
            skipped: true,
            skipReason: reason,
          });
          actionSummaries.push(summaryResult.summary);
        } catch {
          // Ignore action summary generation errors
        }

        const skipResult = {
          skipped: true,
          reason,
          instruction:
            'Do not repeat this exact tool call again. Move to a different evidence path, inspect prior results, checkpoint the blocker, or submit a handoff if blocked.',
        };
        const serialized = JSON.stringify(skipResult);
        const toolResultMessage: Message = {
          id: uuidv4(),
          role: 'tool',
          content: serialized,
          timestamp: Date.now(),
          toolCallId: toolCall.id,
          metadata: {
            toolExecution: this.buildToolExecutionReceipt(
              toolCall.function.name,
              toolCall.id,
              'skipped',
            ),
          },
        } as Message & { toolCallId: string };

        collectedToolResults.push(toolResultMessage);
        currentMessages.push({
          role: 'tool',
          content: serialized,
          tool_call_id: toolCall.id,
        } as OpenAI.Chat.ChatCompletionMessageParam);

        stream.raw('tool_result', {
          name: toolCall.function.name,
          toolCallId: toolCall.id,
          result: skipResult,
        });

        toolCallCount++;
        continue;
      }

      deadlockDetector.record(toolCall.function.name, toolCall.function.arguments);

      // AttemptGuard: Check if this request should be skipped
      const session = this.deps.sessionStore.get(sessionId);
      const methodologyGate = this.getActiveMethodologyRequirement(
        session,
        toolCall.function.name,
        toolCall.function.arguments,
      );
      if (methodologyGate) {
        this.log.info(
          {
            sessionId,
            stepId: methodologyGate.stepId,
            tool: toolCall.function.name,
            requiredSkills: methodologyGate.skills,
          },
          '[MethodologyGate] Skipped tool until active step methodologies are read',
        );

        const payloadInfo = this.extractHttpPayloadInfo(toolCall.function.name, toolCall.function.arguments);
        skippedToolCalls.push({
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          reason: methodologyGate.reason,
          ...(payloadInfo ? { endpoint: payloadInfo.endpoint, technique: payloadInfo.technique } : {}),
        });

        if (args.metricsAccumulator) {
          args.metricsAccumulator.recordToolSkip();
        }

        try {
          const parsedArgs = this.parseJsonRecord(toolCall.function.arguments) ?? {};
          const summaryResult = ActionSummaryEmitter.summarize({
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            args: parsedArgs,
            result: { ok: false, message: methodologyGate.reason },
            durationMs: 0,
            skipped: true,
            skipReason: methodologyGate.reason,
          });
          actionSummaries.push(summaryResult.summary);
        } catch {
          // Ignore action summary generation errors
        }

        const skipResult = {
          skipped: true,
          reason: methodologyGate.reason,
          activePlanStepId: methodologyGate.stepId,
          requiredMethodologySkills: methodologyGate.skills,
          requiredMethodologyPaths: methodologyGate.paths,
        };
        const serialized = JSON.stringify(skipResult);
        const toolResultMessage: Message = {
          id: uuidv4(),
          role: 'tool',
          content: serialized,
          timestamp: Date.now(),
          toolCallId: toolCall.id,
          metadata: {
            toolExecution: this.buildToolExecutionReceipt(
              toolCall.function.name,
              toolCall.id,
              'skipped',
            ),
          },
        } as Message & { toolCallId: string };

        collectedToolResults.push(toolResultMessage);
        currentMessages.push({
          role: 'tool',
          content: serialized,
          tool_call_id: toolCall.id,
        } as OpenAI.Chat.ChatCompletionMessageParam);

        toolCallCount++;
        continue;
      }

      if (session) {
        const guard = new AttemptGuard();
        const payloadInfo = this.extractHttpPayloadInfo(toolCall.function.name, toolCall.function.arguments);
        
        if (payloadInfo) {
          const decision = guard.shouldSkip({
            endpoint: payloadInfo.endpoint,
            technique: payloadInfo.attemptTechnique,
            memory: session.memory,
            currentTurn: args.turnNumber ?? session.turn,
          });

          if (decision.skip) {
            this.log.info(
              { sessionId, endpoint: payloadInfo.endpoint, technique: payloadInfo.attemptTechnique },
              `[AttemptGuard] Skipped: ${decision.reason}`
            );

            // Create a tool result indicating the skip
            const skipResult = {
              skipped: true,
              reason: decision.reason,
              endpoint: payloadInfo.endpoint,
              technique: payloadInfo.technique,
              attemptTechnique: payloadInfo.attemptTechnique,
            };

            skippedToolCalls.push({
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              reason: decision.reason,
              endpoint: payloadInfo.endpoint,
              technique: payloadInfo.technique,
            });

            if (args.metricsAccumulator) {
              args.metricsAccumulator.recordToolSkip();
            }

            // Generate action summary for skipped tool (Trace Observability v2)
            try {
              const parsedArgs = JSON.parse(toolCall.function.arguments);
              const summaryResult = ActionSummaryEmitter.summarize({
                toolName: toolCall.function.name,
                toolCallId: toolCall.id,
                args: parsedArgs,
                result: { ok: false, message: decision.reason },
                durationMs: 0,
                skipped: true,
                skipReason: decision.reason,
              });
              actionSummaries.push(summaryResult.summary);
            } catch {
              // Ignore action summary generation errors
            }

            // Add to collected results
            const toolResultMessage: Message = {
              id: uuidv4(),
              role: 'tool',
              content: JSON.stringify(skipResult),
              timestamp: Date.now(),
              toolCallId: toolCall.id,
              metadata: {
                toolExecution: this.buildToolExecutionReceipt(
                  toolCall.function.name,
                  toolCall.id,
                  'skipped',
                ),
              },
            } as Message & { toolCallId: string };

            collectedToolResults.push(toolResultMessage);
            currentMessages.push({
              role: 'tool',
              content: JSON.stringify(skipResult),
              tool_call_id: toolCall.id,
            } as OpenAI.Chat.ChatCompletionMessageParam);

            toolCallCount++;
            continue; // Skip to next tool call
          }
        }
      }

      // Time tool execution for metrics
      const toolStart = Date.now();
      let toolSuccess = false;
      let toolResult: unknown;
      let toolDurationMs = 0;
      let executionReceipt = this.buildToolExecutionReceipt(
        toolCall.function.name,
        toolCall.id,
        'failed',
        args.modelRequestId,
      );

      try {
        const execution = await this.deps.toolsRegistry.executeWithReceipt(
          toolCall.function.name,
          {},
          {
            sessionId,
            modelRequestId: args.modelRequestId,
            rawArgsJson: toolCall.function.arguments,
            toolCallId: toolCall.id,
            turnNumber: args.turnNumber,
            abortSignal,
            budget: {
              maxToolCalls: args.maxToolCalls,
              usedToolCalls: (args.sessionToolCallCount ?? 0) + toolCallCount,
              remainingToolCalls:
                typeof args.maxToolCalls === 'number'
                  ? Math.max(0, args.maxToolCalls - ((args.sessionToolCallCount ?? 0) + toolCallCount))
                  : undefined,
              reservedToolCalls: args.reservedToolCalls,
            },
            stream,
            executeModelCall: this.deps.executeModelCall,
          },
        );
        toolResult = execution.result;
        executionReceipt = execution.receipt;
        toolSuccess = executionReceipt.outcome === 'succeeded';
      } catch (error: unknown) {
        toolSuccess = false;
        executionReceipt = this.buildToolExecutionReceipt(
          toolCall.function.name,
          toolCall.id,
          abortSignal.aborted ? 'interrupted' : 'failed',
          args.modelRequestId,
        );
        throw error;
      } finally {
        // Record tool execution to Prometheus histogram
        toolDurationMs = Date.now() - toolStart;
        recordToolExec(toolCall.function.name, toolDurationMs, toolSuccess);

        // Record tool metrics for wide turn events
        if (args.metricsAccumulator) {
          args.metricsAccumulator.recordToolCall({
            name: toolCall.function.name,
            durationMs: toolDurationMs,
            success: toolSuccess,
            outcome: this.toToolMetricOutcome(executionReceipt.outcome),
          });
        }
      }

      const parsedArgs = this.parseJsonRecord(toolCall.function.arguments) ?? {};
      const pendingApproval = this.extractPendingApproval(
        toolCall.function.name,
        toolResult,
        toolCall.id,
        parsedArgs,
      );
      const awaitingApprovalContext = this.extractAwaitingApprovalControl(toolResult);

      if (pendingApproval) {
        const approvalResultMessage: Message = {
          id: uuidv4(),
          role: 'tool',
          content: JSON.stringify(toolResult),
          timestamp: Date.now(),
          toolCallId: toolCall.id,
          metadata: {
            toolExecution: { ...executionReceipt, outcome: 'awaiting_approval' },
          },
        } as Message & { toolCallId: string };

        collectedToolResults.push(approvalResultMessage);
        currentMessages.push({
          role: 'tool',
          content: approvalResultMessage.content,
          tool_call_id: toolCall.id,
        } as OpenAI.Chat.ChatCompletionMessageParam);

        toolCallCount++;

        return finish({
          currentMessages,
          toolCallCount,
          skippedToolCalls,
          status: 'awaiting_approval',
          pendingApproval,
          collectedToolResults,
          actionSummaries,
          discoveries,
          memoryUpdates,
          toolResultEvents,
        });
      }

      if (awaitingApprovalContext) {
        const approvalResultMessage: Message = {
          id: uuidv4(),
          role: 'tool',
          content: JSON.stringify(toolResult),
          timestamp: Date.now(),
          toolCallId: toolCall.id,
          metadata: {
            toolExecution: { ...executionReceipt, outcome: 'awaiting_approval' },
          },
        } as Message & { toolCallId: string };

        collectedToolResults.push(approvalResultMessage);
        currentMessages.push({
          role: 'tool',
          content: approvalResultMessage.content,
          tool_call_id: toolCall.id,
        } as OpenAI.Chat.ChatCompletionMessageParam);

        toolCallCount++;

        return finish({
          currentMessages,
          toolCallCount,
          skippedToolCalls,
          status: 'awaiting_approval',
          awaitingApprovalContext,
          collectedToolResults,
          actionSummaries,
          discoveries,
          memoryUpdates,
          toolResultEvents,
        });
      }

      // Record attempt in memory (if http_payload)
      if (session?.memory) {
        const payloadInfo = this.extractHttpPayloadInfo(toolCall.function.name, toolCall.function.arguments);
        if (payloadInfo) {
          const wasKnownEndpoint = session.memory.testedEndpoints.includes(payloadInfo.endpoint);
          const classified = this.classifyHttpAttemptResult(toolSuccess, toolResult);
          if (!classified.shouldRecord) {
            this.log.debug(
              { endpoint: payloadInfo.endpoint, technique: payloadInfo.technique, reason: classified.reason },
              '[AttemptGuard] Skipped memory record for non-actionable HTTP result'
            );
          } else {
            const result = classified.result;
            const reason = classified.reason ?? '';
            const attemptKey = createAttemptKey(payloadInfo.endpoint, payloadInfo.attemptTechnique);
            const statusCode = this.extractHttpStatusCode(toolResult);

            const attemptResult = MemoryManager.recordAttempt(session.memory, {
              endpoint: payloadInfo.endpoint,
              technique: payloadInfo.attemptTechnique,
              result,
              currentTurn: args.turnNumber ?? session.turn,
              reason,
              toolCallId: toolCall.id,
            });

            // Generate memory.update event for trace observability
            memoryUpdates.push({
              operation: attemptResult.failureRecorded ? 'failure_recorded' : 'attempt_recorded',
              change: {
                type: attemptResult.failureRecorded ? 'failure' : 'attempt',
                key: attemptKey,
                value: { endpoint: payloadInfo.endpoint, technique: payloadInfo.technique, result },
              },
              memoryStats: attemptResult.stats,
            });

            this.log.debug(
              { endpoint: payloadInfo.endpoint, technique: payloadInfo.technique, result },
              '[AttemptGuard] Recorded attempt in memory'
            );

            if (!wasKnownEndpoint && typeof statusCode === 'number' && statusCode >= 200 && statusCode <= 299) {
              this.recordFact(session.memory, memoryUpdates, {
                category: 'endpoint',
                key: `endpoint:${payloadInfo.endpoint}`,
                value: {
                  endpoint: payloadInfo.endpoint,
                  technique: payloadInfo.technique,
                  statusCode,
                },
                confidence: 0.9,
                source: toolCall.id,
              });
            }
          }
        }
      }

      // ATOMIC PERSISTENCE: Collect tool result message, don't persist yet.
      // TurnRunner will batch persist assistant + all tool results together.
      // ToolResultPolicy owns result normalization and artifact preview projection.
      const projection = await projectToolResultForPrompt({
        workspaceDir,
        toolName: toolCall.function.name,
        toolCallId: toolCall.id,
        result: toolResult,
      });
      const resultContent = projection.content;
      if (projection.stats.persisted || projection.stats.savedApproxTokens > 0) {
        toolResultEvents.push(projection.stats);
      }

      const toolResultMessage: Message = {
        id: uuidv4(),
        role: 'tool',
        content: resultContent,
        timestamp: Date.now(),
        toolCallId: toolCall.id,
        metadata: {
          toolExecution: executionReceipt,
        },
      } as Message & { toolCallId: string };

      // Collect for batch persistence (no appendMessageAsync call here!)
      collectedToolResults.push(toolResultMessage);

      currentMessages.push({
        role: 'tool',
        content: resultContent,
        tool_call_id: toolCall.id,
      } as OpenAI.Chat.ChatCompletionMessageParam);

      // Generate action summary for executed tool (Trace Observability v2)
      try {
        const summaryResultInput = this.toActionSummaryResult(toolResult, toolSuccess);
        const summaryResult = ActionSummaryEmitter.summarize({
          toolName: toolCall.function.name,
          toolCallId: toolCall.id,
          args: parsedArgs,
          result: summaryResultInput,
          durationMs: toolDurationMs,
        });

        actionSummaries.push(summaryResult.summary);

        // Add any discoveries found in the tool output
        if (summaryResult.discoveries.length > 0) {
          discoveries.push(...summaryResult.discoveries);
        }
      } catch {
        // Ignore action summary generation errors
      }

      toolCallCount++;

      // Auto-checkpoint in automated mode: create checkpoint every N tool calls
      const isAutomated = args.isAutomated ?? false;
      const sessionToolCalls = (args.sessionToolCallCount ?? 0) + toolCallCount;
      if (isAutomated && this.shouldAutoCheckpoint(sessionToolCalls)) {
        await this.createAutoCheckpoint(sessionId, sessionToolCalls, stream);
      }
    }

    return finish({
      currentMessages,
      toolCallCount,
      skippedToolCalls,
      collectedToolResults,
      actionSummaries,
      discoveries,
      memoryUpdates,
      toolResultEvents,
    });
  }
}
