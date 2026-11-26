import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { ToolsRegistryAdapter } from '../../../../src/domains/agent-brain/adapters/ToolsRegistryAdapter';
import { ToolsRegistry } from '../../../../src/domains/agent-brain/adapters/tools/ToolsRegistry';
import type { SandboxAdapter } from '../../../../src/domains/agent-brain/adapters/sandbox';
import { SessionStore } from '../../../../src/domains/agent-brain/application/core/SessionStore';
import { StreamBroker } from '../../../../src/domains/agent-brain/application/core/StreamBroker';
import { ModelRuntime } from '../../../../src/domains/agent-brain/application/orchestration/ModelRuntime';
import { TurnToolExecutor } from '../../../../src/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { StreamBroker as ToolCallStreamBroker } from '../../../../src/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import {
  TOOL_EXECUTION_PIPELINE_STAGES,
  ToolLifecycleHookRegistry,
  type ToolExecutionPipelineStage,
} from '../../../../src/domains/agent-brain/application/tools';
import { canonicalizeModelRequestEnvelope } from '../../../../src/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import { createResearchLabRuntimeHostCapabilities } from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import type {
  Message,
  StreamEvent,
  ToolExecutionReceiptV1,
} from '../../../../src/domains/agent-brain/domain/types';
import { SessionTraceRecorder } from '../../../../src/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';
import {
  buildProviderAttemptIntegrityExpectations,
  buildToolTracePairingExpectations,
  reconcileTraceIntegrity,
} from '../../../../src/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';
import { UsageRecorder } from '../../../../src/domains/agent-brain/infrastructure/usage/UsageRecorder';
import type { ModelAttemptRecord, WorkspaceManager } from '../../../../src/domains/agent-brain/ports';
import { InMemoryUsageStore } from '../../../../src/domains/platform/subscriptions/infrastructure/usageStores';
import {
  E8BehaviorModelRequestStore,
  E8BehaviorToolExecutionStore,
} from '../E8BehaviorLifecycleStores';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E8_ASSEMBLED_SCENARIO_ID =
  'harness-unified-tool-pipeline-preserves-decisions-and-results';

const READ_TOOL = 'behavior_pipeline_read';
const UPDATE_TOOL = 'behavior_pipeline_update';
const DENIED_TOOL = 'behavior_pipeline_denied';
const FULL_PIPELINE = [...TOOL_EXECUTION_PIPELINE_STAGES];

type TemporaryState = {
  value: string;
  dispatches: { read: number; update: number; denied: number };
};

type ProducedToolCall = {
  requestId: string;
  toolCall: { id: string; function: { name: string; arguments: string } };
};

type FrozenResultObservation = {
  toolName: string;
  rootFrozen: boolean;
  nestedFrozen: boolean;
  mutationRejected: boolean;
};

type ToolDecisionEvidence = {
  toolName: string;
  requestId: string;
  toolCallId: string;
  result: unknown;
  receipt: ToolExecutionReceiptV1;
};

export type UnifiedToolPipelineEvidenceBundle = {
  schema: 'behavior-lab-unified-tool-pipeline-evidence/v1';
  scenarioId: typeof E8_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  catalogCoverage: {
    schema: 'tool-execution-pipeline/v1';
    owner: 'ToolsRegistry.executeResolvedTool';
    executableToolIds: string[];
    uncoveredToolIds: string[];
  };
  differential: {
    legacyResult: unknown;
    unifiedResult: unknown;
    legacyDispatches: number;
    unifiedDispatches: number;
  };
  decisions: {
    allowed: ToolDecisionEvidence;
    approvalInitial: ToolDecisionEvidence;
    approvalResumed: ToolDecisionEvidence;
    denied: ToolDecisionEvidence;
    wideningNegative: ToolDecisionEvidence;
  };
  lifecycle: {
    approvalEvents: number;
    finalState: TemporaryState;
    toolRecords: Array<{
      toolCallId: string;
      toolName: string;
      modelRequestId?: string;
      status: string;
    }>;
    requestIds: string[];
    attempts: ModelAttemptRecord[];
    frozenResults: FrozenResultObservation[];
    invariantTraceEvents: number;
    integrity: ReturnType<typeof reconcileTraceIntegrity>;
    orchestrationMs: number[];
    perCallBudgetMs: number;
  };
  assertions: VerificationAssertion[];
  verdict: {
    correctedFixturePassed: boolean;
    negativeControlDetected: boolean;
    namedMismatches: string[];
  };
};

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
): VerificationAssertion => ({
  id,
  passed,
  expected,
  actual,
  authoritativeSource: 'E3 tool ledger + E4 request ledger + E6 trace + E7 attempt ledger',
  detail,
});

const makeWorkspaceManager = (root: string): WorkspaceManager => ({
  allocateWorkspace(ownerId) {
    return path.resolve(root, 'workspaces', ownerId);
  },
  async ensureWorkspace(workspaceDir) {
    await fs.mkdir(workspaceDir, { recursive: true });
  },
  async cleanupWorkspace(workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  },
});

const readState = async (filePath: string): Promise<TemporaryState> =>
  JSON.parse(await fs.readFile(filePath, 'utf8')) as TemporaryState;

const parseToolMessage = (message: Message | undefined): unknown => {
  if (!message) return undefined;
  try {
    return JSON.parse(message.content) as unknown;
  } catch {
    return message.content;
  }
};

const receiptFrom = (message: Message | undefined): ToolExecutionReceiptV1 => {
  const receipt = message?.metadata?.toolExecution;
  if (!receipt) throw new Error('E8 fixture tool message omitted its execution receipt');
  return receipt;
};

const completedStages = (receipt: ToolExecutionReceiptV1): string[] =>
  receipt.pipeline?.completedStages ?? [];

const runScenario = async (): Promise<AssembledScenarioResult<UnifiedToolPipelineEvidenceBundle>> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'null-ai-e8-pipeline-'));
  const toolsDir = path.resolve(__dirname, '..', 'fixtures', 'e8-tools');
  const fixtureModulePath = path.resolve(toolsDir, 'unified-pipeline.cjs');
  const legacyStatePath = path.resolve(root, 'legacy-state.json');
  const unifiedStatePath = path.resolve(root, 'unified-state.json');
  const initialState: TemporaryState = {
    value: 'initial',
    dispatches: { read: 0, update: 0, denied: 0 },
  };
  await fs.writeFile(legacyStatePath, `${JSON.stringify(initialState)}\n`, 'utf8');
  await fs.writeFile(unifiedStatePath, `${JSON.stringify(initialState)}\n`, 'utf8');

  const traceRoot = path.resolve(root, 'trace');
  const traceRecorder = new SessionTraceRecorder({
    rootDir: traceRoot,
    inlineLimit: 512,
    stdoutChunkSize: 1024,
    compressOverBytes: 1024 * 1024,
    retentionDays: 1,
  });
  const sessionStore = new SessionStore({
    workspaceManager: makeWorkspaceManager(root),
    traceRecorder,
    sessionTTL: 60_000,
  });
  const streamBroker = new StreamBroker();
  const streamEvents: StreamEvent[] = [];
  const hookRegistry = new ToolLifecycleHookRegistry();
  const frozenResults: FrozenResultObservation[] = [];
  const stageObservations: Array<{
    toolCallId?: string;
    toolName: string;
    stage?: ToolExecutionPipelineStage;
  }> = [];
  hookRegistry.register({
    onPipelineStage(context) {
      stageObservations.push({
        toolCallId: context.toolCallId,
        toolName: context.toolName,
        stage: context.stage,
      });
    },
    onPostToolUse(context) {
      const result = context.result as Record<string, unknown>;
      const nested = result && typeof result === 'object'
        ? Object.values(result).find((value) => value && typeof value === 'object')
        : undefined;
      let mutationRejected = false;
      try {
        result.__e8Mutation = true;
      } catch {
        mutationRejected = true;
      }
      frozenResults.push({
        toolName: context.toolName,
        rootFrozen: Object.isFrozen(result),
        nestedFrozen: nested ? Object.isFrozen(nested) : true,
        mutationRejected,
      });
    },
  });

  const toolLifecycle = new E8BehaviorToolExecutionStore(
    path.resolve(root, 'tool-executions.json'),
  );
  const requestLifecycle = new E8BehaviorModelRequestStore(
    path.resolve(root, 'model-requests.json'),
  );
  const usageStore = new InMemoryUsageStore();
  const capabilities = createResearchLabRuntimeHostCapabilities();
  let unsubscribe = (): void => undefined;

  try {
    const session = await sessionStore.create({
      modelName: 'scripted-e8',
      modelContextWindow: 128_000,
      modelMaxOutputTokens: 256,
      mode: 'interactive',
      agentType: 'executor',
      promptProfile: 'executor',
      toolPolicy: {
        allow: ['*'],
        ask: [UPDATE_TOOL],
        deny: [DENIED_TOOL],
      },
      flags: {
        model_selection: { resolvedModelId: 'scripted-e8' },
        behaviorLab: { scenarioId: E8_ASSEMBLED_SCENARIO_ID },
      },
    });
    unsubscribe = streamBroker.subscribe(session.id, (event) => streamEvents.push(event));
    await traceRecorder.init(session.id, {
      workspace: session.workspaceDir,
      tools: [READ_TOOL, UPDATE_TOOL, DENIED_TOOL],
      model: 'scripted-e8',
      agentRole: 'behavior_lab_verifier',
    });

    const registry = new ToolsRegistry(
      streamBroker,
      sessionStore,
      {} as SandboxAdapter,
      undefined,
      traceRecorder,
      {
        toolsDir,
        devWatch: false,
        toolExecutionDb: toolLifecycle,
        toolLifecycleHooks: hookRegistry,
        runtimeHostCapabilities: capabilities,
      },
    );
    await registry.whenReady();
    const registryAdapter = new ToolsRegistryAdapter(registry);
    const executor = new TurnToolExecutor({ sessionStore, toolsRegistry: registryAdapter });
    const usageRecorder = new UsageRecorder(
      sessionStore,
      undefined,
      usageStore,
      'scripted-e8',
      undefined,
      undefined,
      traceRecorder,
      traceRoot,
    );
    const modelRuntime = new ModelRuntime();
    let callOrdinal = 0;

    const produce = async (
      toolName: string,
      toolCallId: string,
      args: Record<string, unknown>,
    ): Promise<ProducedToolCall> => {
      callOrdinal += 1;
      const signal = new AbortController().signal;
      const request = {
        sessionId: session.id,
        messages: [{ role: 'user' as const, content: `Invoke ${toolName}.` }],
        tools: [{
          type: 'function' as const,
          function: {
            name: toolName,
            description: `${toolName} E8 fixture`,
            parameters: {
              type: 'object',
              properties: { statePath: { type: 'string' }, value: { type: 'string' } },
              required: ['statePath'],
              additionalProperties: false,
            },
          },
        }],
        signal,
        maxTokens: 256,
      };
      const canonical = canonicalizeModelRequestEnvelope({
        model: 'scripted-e8',
        messages: request.messages,
        tools: request.tools,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: request.maxTokens,
      });
      const model = {
        providerName: 'behavior-scripted-e8',
        getContextCapacity: () => 128_000,
        projectCacheSurface: () => undefined,
        prepare: () => ({ envelope: canonical.envelope, digest: canonical.digest, signal }),
        startPrepared: async () => ({
          message: {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function' as const,
              function: { name: toolName, arguments: JSON.stringify(args) },
            }],
          },
          content: '',
          toolCalls: [{ id: toolCallId, function: { name: toolName, arguments: JSON.stringify(args) } }],
          totalChars: 0,
          preview: '',
          chunks: [
            { type: 'tool_call' as const, name: toolName, args: JSON.stringify(args) },
            { type: 'done' as const },
          ],
          usage: {
            promptTokens: 30,
            promptTokensDetails: { cachedTokens: 5, cacheWriteTokens: 3 },
            completionTokens: 10,
            totalTokens: 40,
          },
          providerRequestId: `provider-e8-${callOrdinal}`,
          reportedModel: 'scripted-e8',
          reasoningStats: {
            chars: 8,
            estimatedTokens: 2,
            estimated: true,
            source: 'estimated' as const,
          },
        }),
      };
      const produced = await modelRuntime.execute({
        model: model as never,
        usageRecorder,
        request,
        sessionId: session.id,
        turn: callOrdinal,
        callOrdinal,
        configuredModelName: 'scripted-e8',
        maxRetries: 0,
        modelRequestPort: requestLifecycle,
        modelRequestCapability: capabilities.modelRequests,
        routedContextCapacity: 128_000,
      });
      if (!produced.requestId || !produced.result.toolCalls[0]) {
        throw new Error(`E8 scripted provider omitted ${toolName} request lineage`);
      }
      return { requestId: produced.requestId, toolCall: produced.result.toolCalls[0] };
    };

    const runThroughExecutor = async (produced: ProducedToolCall) => {
      const events: StreamEvent[] = [];
      const startedAt = performance.now();
      const execution = await executor.run({
        sessionId: session.id,
        abortSignal: new AbortController().signal,
        toolCalls: [produced.toolCall],
        modelRequestId: produced.requestId,
        stream: new ToolCallStreamBroker((event) => events.push(event)),
        turnNumber: callOrdinal,
        maxToolCalls: 1,
      });
      return { execution, events, elapsedMs: performance.now() - startedAt };
    };

    const legacyModule = require(fixtureModulePath) as {
      legacyRead: (args: Record<string, unknown>) => Promise<{ data: unknown }>;
    };
    const legacyRawResult = await legacyModule.legacyRead({ statePath: legacyStatePath });
    const legacyState = await readState(legacyStatePath);

    const allowedProduced = await produce(READ_TOOL, 'e8-call-read', { statePath: unifiedStatePath });
    const allowedRun = await runThroughExecutor(allowedProduced);
    const allowedMessage = allowedRun.execution.collectedToolResults[0];
    const allowedResult = parseToolMessage(allowedMessage);
    const allowedReceipt = receiptFrom(allowedMessage);

    const approvalProduced = await produce(
      UPDATE_TOOL,
      'e8-call-update',
      { statePath: unifiedStatePath, value: 'approved' },
    );
    const approvalInitialRun = await runThroughExecutor(approvalProduced);
    const approvalInitialMessage = approvalInitialRun.execution.collectedToolResults[0];
    const approvalInitialReceipt = receiptFrom(approvalInitialMessage);
    const decision = await registry.handleApprovalDecision(
      session.id,
      approvalProduced.toolCall.id,
      'granted',
    );
    if (!decision.handled || !decision.needsResume) {
      throw new Error('E8 fixture approval did not remain resumable');
    }
    const approvalResumeStartedAt = performance.now();
    const approvalResumed = await registry.executeWithReceipt(
      UPDATE_TOOL,
      { statePath: unifiedStatePath, value: 'approved' },
      {
        sessionId: session.id,
        toolCallId: approvalProduced.toolCall.id,
        modelRequestId: approvalProduced.requestId,
        turnNumber: callOrdinal,
      },
    );
    const approvalResumeElapsedMs = performance.now() - approvalResumeStartedAt;

    const deniedProduced = await produce(
      DENIED_TOOL,
      'e8-call-denied',
      { statePath: unifiedStatePath },
    );
    const deniedRun = await runThroughExecutor(deniedProduced);
    const deniedMessage = deniedRun.execution.collectedToolResults[0];
    const deniedReceipt = receiptFrom(deniedMessage);

    const wideningProduced = await produce(
      DENIED_TOOL,
      'e8-call-widening-negative',
      { statePath: unifiedStatePath },
    );
    const unregisterWideningHook = hookRegistry.register({
      onPermissionDecision(context) {
        if (context.toolCallId !== wideningProduced.toolCall.id) return undefined;
        return {
          decision: {
            ...context.decision,
            behavior: 'allow',
            reason: 'negative control attempts to widen deny to allow',
          },
        };
      },
    });
    const wideningExecution = await registry.executeWithReceipt(
      DENIED_TOOL,
      { statePath: unifiedStatePath },
      {
        sessionId: session.id,
        toolCallId: wideningProduced.toolCall.id,
        modelRequestId: wideningProduced.requestId,
        turnNumber: callOrdinal,
      },
    );
    unregisterWideningHook();

    const catalogCoverage = await registryAdapter.getUnifiedPipelineCoverage();
    const finalState = await readState(unifiedStatePath);
    const toolRecords = await toolLifecycle.findBySession(session.id);
    const requestRecords = await requestLifecycle.findBySession(session.id);
    const attempts = await usageStore.listAttemptsBySession(session.id);

    await traceRecorder.close(session.id, {
      terminal: 'session.done',
      status: 'completed',
      turns: callOrdinal,
    });
    const tracePath = path.resolve(traceRoot, session.id, 'trace.ndjson');
    const traceText = await fs.readFile(tracePath, 'utf8');
    const traceEvents = traceText.trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const acceptedHighWater = traceEvents.reduce(
      (highWater, event) => Math.max(
        highWater,
        typeof event.acceptedOrdinal === 'number' ? event.acceptedOrdinal : 0,
      ),
      0,
    );
    const tracePairs = traceEvents.map((event) => ({
      event: typeof event.event === 'string' ? event.event : '',
      toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
    }));
    const requestIds = requestRecords.map((record) => record.requestId);
    const integrity = reconcileTraceIntegrity({
      sessionId: session.id,
      acceptedHighWater,
      persistedHighWater: acceptedHighWater,
      terminalReceipt: true,
      expectations: [
        ...requestIds.map((requestId) => ({
          surface: 'model_requests' as const,
          id: requestId,
          present: true,
        })),
        ...buildProviderAttemptIntegrityExpectations(requestIds, attempts),
        ...toolRecords.map((record) => ({
          surface: 'tool_executions' as const,
          id: record.toolCallId,
          present: true,
          valid: Boolean(record.modelRequestId)
            && requestIds.includes(record.modelRequestId ?? '')
            && record.status === 'succeeded',
        })),
        ...buildToolTracePairingExpectations(tracePairs),
      ],
    });
    const invariantTraceEvents = traceEvents.filter(
      (event) => event.event === 'tool.pipeline.invariant_rejected'
        && event.toolCallId === wideningProduced.toolCall.id,
    ).length;
    const approvalEvents = streamEvents.filter((event) => event.type === 'approval_needed').length;
    const orchestrationMs = [allowedRun.elapsedMs, approvalResumeElapsedMs];
    const perCallBudgetMs = 2_000;

    const decisions = {
      allowed: {
        toolName: READ_TOOL,
        requestId: allowedProduced.requestId,
        toolCallId: allowedProduced.toolCall.id,
        result: allowedResult,
        receipt: allowedReceipt,
      },
      approvalInitial: {
        toolName: UPDATE_TOOL,
        requestId: approvalProduced.requestId,
        toolCallId: approvalProduced.toolCall.id,
        result: parseToolMessage(approvalInitialMessage),
        receipt: approvalInitialReceipt,
      },
      approvalResumed: {
        toolName: UPDATE_TOOL,
        requestId: approvalProduced.requestId,
        toolCallId: approvalProduced.toolCall.id,
        result: approvalResumed.result,
        receipt: approvalResumed.receipt,
      },
      denied: {
        toolName: DENIED_TOOL,
        requestId: deniedProduced.requestId,
        toolCallId: deniedProduced.toolCall.id,
        result: parseToolMessage(deniedMessage),
        receipt: deniedReceipt,
      },
      wideningNegative: {
        toolName: DENIED_TOOL,
        requestId: wideningProduced.requestId,
        toolCallId: wideningProduced.toolCall.id,
        result: wideningExecution.result,
        receipt: wideningExecution.receipt,
      },
    } satisfies UnifiedToolPipelineEvidenceBundle['decisions'];

    const dispatchRequestIds = new Map(toolRecords.map((record) => [
      record.toolCallId,
      record.modelRequestId,
    ]));
    const frozenSuccessfulResults = frozenResults.filter(
      (entry) => entry.toolName === READ_TOOL || entry.toolName === UPDATE_TOOL,
    );
    const assertions = [
      assertion(
        'catalog.every_executable_tool_uses_unified_owner',
        catalogCoverage.uncoveredToolIds.length === 0
          && catalogCoverage.executableToolIds.join(',') === [DENIED_TOOL, READ_TOOL, UPDATE_TOOL].sort().join(','),
        { owner: 'ToolsRegistry.executeResolvedTool', uncovered: [], tools: [DENIED_TOOL, READ_TOOL, UPDATE_TOOL].sort() },
        catalogCoverage,
        'Every manifest-bearing executable module is routed by the registry method that owns E8 stages.',
      ),
      assertion(
        'differential.allowed_read_result_and_single_dispatch',
        JSON.stringify(legacyRawResult.data) === JSON.stringify(allowedResult)
          && legacyState.dispatches.read === 1
          && finalState.dispatches.read === 1,
        { equivalent: true, legacyDispatches: 1, unifiedDispatches: 1 },
        { legacyResult: legacyRawResult.data, allowedResult, legacyState, finalState },
        'Legacy and unified paths run in isolated fixtures; neither invocation dual-dispatches.',
      ),
      assertion(
        'ordering.allowed_and_resumed_follow_exact_pipeline',
        completedStages(allowedReceipt).join(',') === FULL_PIPELINE.join(',')
          && completedStages(approvalResumed.receipt).join(',') === FULL_PIPELINE.join(','),
        { allowed: FULL_PIPELINE, resumed: FULL_PIPELINE },
        {
          allowed: completedStages(allowedReceipt),
          resumed: completedStages(approvalResumed.receipt),
          observedStages: stageObservations.length,
        },
        'Both real dispatches expose the exact immutable 13-stage lifecycle in their receipts.',
      ),
      assertion(
        'approval.occurs_once_before_single_update_dispatch',
        approvalEvents === 1
          && approvalInitialRun.execution.status === 'awaiting_approval'
          && completedStages(approvalInitialReceipt).join(',') === 'resolve,validate,describe,decide'
          && finalState.dispatches.update === 1,
        { approvalEvents: 1, initialStages: ['resolve', 'validate', 'describe', 'decide'], dispatches: 1 },
        {
          approvalEvents,
          status: approvalInitialRun.execution.status,
          initialStages: completedStages(approvalInitialReceipt),
          updateDispatches: finalState.dispatches.update,
        },
        'The ask decision stops before claim; the granted resume crosses the dispatch boundary once.',
      ),
      assertion(
        'denied.tool_never_claims_or_dispatches',
        finalState.dispatches.denied === 0
          && deniedReceipt.outcome === 'blocked'
          && !toolRecords.some((record) => record.toolCallId === deniedProduced.toolCall.id),
        { dispatches: 0, outcome: 'blocked', ledgerRows: 0 },
        {
          dispatches: finalState.dispatches.denied,
          outcome: deniedReceipt.outcome,
          ledgerRows: toolRecords.filter((record) => record.toolCallId === deniedProduced.toolCall.id).length,
        },
        'A denied decision terminates before claim, start, or module dispatch.',
      ),
      assertion(
        'lineage.each_dispatch_has_one_e3_record_and_e4_parent',
        toolRecords.length === 2
          && requestIds.length === 4
          && dispatchRequestIds.get(allowedProduced.toolCall.id) === allowedProduced.requestId
          && dispatchRequestIds.get(approvalProduced.toolCall.id) === approvalProduced.requestId,
        { toolRecords: 2, modelRequests: 4, eachDispatchJoined: true },
        {
          toolRecords: toolRecords.map((record) => ({
            toolCallId: record.toolCallId,
            modelRequestId: record.modelRequestId,
            status: record.status,
          })),
          requestIds,
        },
        'Each actual dispatch owns one terminal E3 row joined to the immutable E4 request that produced it.',
      ),
      assertion(
        'result.terminal_value_is_frozen_before_post_hooks',
        frozenSuccessfulResults.length === 2
          && frozenSuccessfulResults.every((entry) =>
            entry.rootFrozen && entry.nestedFrozen && entry.mutationRejected),
        { observations: 2, rootFrozen: true, nestedFrozen: true, mutationRejected: true },
        frozenSuccessfulResults,
        'Post hooks observe the already-settled frozen value and cannot mutate presentation output.',
      ),
      assertion(
        'integrity.e6_e7_requests_attempts_tools_and_trace_reconcile',
        attempts.length === 4
          && attempts.every((attempt) => attempt.state === 'succeeded' && attempt.requestId)
          && integrity.status === 'complete',
        { attempts: 4, allSucceeded: true, integrity: 'complete' },
        { attempts, integrity },
        'Provider usage remains one terminal E7 attempt per E4 request and E6 sees complete tool trace pairs.',
      ),
      assertion(
        'performance.local_orchestration_inside_budget',
        orchestrationMs.every((elapsed) => elapsed <= perCallBudgetMs),
        `each local dispatch <= ${perCallBudgetMs}ms`,
        orchestrationMs,
        'The deterministic assembled path includes ledger and trace I/O and remains within the conservative gate budget.',
      ),
      assertion(
        'negative.monotonic_policy_widening_is_rejected_and_recorded',
        (wideningExecution.result as { pipelineInvariant?: string }).pipelineInvariant === 'decision_monotonicity'
          && invariantTraceEvents === 1
          && finalState.dispatches.denied === 0
          && !toolRecords.some((record) => record.toolCallId === wideningProduced.toolCall.id),
        { invariant: 'decision_monotonicity', traceEvents: 1, dispatches: 0, ledgerRows: 0 },
        {
          result: wideningExecution.result,
          invariantTraceEvents,
          deniedDispatches: finalState.dispatches.denied,
          ledgerRows: toolRecords.filter((record) => record.toolCallId === wideningProduced.toolCall.id).length,
        },
        'A decision hook cannot turn deny into allow; the invariant is an accepted trace observation.',
      ),
    ];

    const evidence: UnifiedToolPipelineEvidenceBundle = {
      schema: 'behavior-lab-unified-tool-pipeline-evidence/v1',
      scenarioId: E8_ASSEMBLED_SCENARIO_ID,
      generatedAt: new Date().toISOString(),
      commit: commit(),
      catalogCoverage,
      differential: {
        legacyResult: legacyRawResult.data,
        unifiedResult: allowedResult,
        legacyDispatches: legacyState.dispatches.read,
        unifiedDispatches: finalState.dispatches.read,
      },
      decisions,
      lifecycle: {
        approvalEvents,
        finalState,
        toolRecords: toolRecords.map((record) => ({
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          modelRequestId: record.modelRequestId,
          status: record.status,
        })),
        requestIds,
        attempts,
        frozenResults,
        invariantTraceEvents,
        integrity,
        orchestrationMs,
        perCallBudgetMs,
      },
      assertions,
      verdict: {
        correctedFixturePassed: assertions.slice(0, -1).every((entry) => entry.passed),
        negativeControlDetected: assertions.at(-1)?.passed === true,
        namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
      },
    };
    const passed = assertions.every((entry) => entry.passed);
    return {
      id: E8_ASSEMBLED_SCENARIO_ID,
      title: 'Harness unified tool pipeline preserves decisions and results',
      mode: 'assembled-runtime',
      passed,
      evidence,
      ...(!passed ? { error: `failed=${evidence.verdict.namedMismatches.join(',')}` } : {}),
    };
  } finally {
    unsubscribe();
    sessionStore.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
};

export const unifiedToolPipelineEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-unified-tool-pipeline-evidence/v1'),
  scenarioId: z.literal(E8_ASSEMBLED_SCENARIO_ID),
  catalogCoverage: z.object({
    schema: z.literal('tool-execution-pipeline/v1'),
    owner: z.literal('ToolsRegistry.executeResolvedTool'),
    executableToolIds: z.array(z.string()).length(3),
    uncoveredToolIds: z.array(z.string()).length(0),
  }),
  differential: z.object({
    legacyDispatches: z.literal(1),
    unifiedDispatches: z.literal(1),
  }).passthrough(),
  decisions: z.object({
    allowed: z.object({ receipt: z.object({ outcome: z.literal('succeeded') }).passthrough() }).passthrough(),
    approvalInitial: z.object({ receipt: z.object({ outcome: z.literal('awaiting_approval') }).passthrough() }).passthrough(),
    approvalResumed: z.object({ receipt: z.object({ outcome: z.literal('succeeded') }).passthrough() }).passthrough(),
    denied: z.object({ receipt: z.object({ outcome: z.literal('blocked') }).passthrough() }).passthrough(),
    wideningNegative: z.object({ receipt: z.object({ outcome: z.literal('blocked') }).passthrough() }).passthrough(),
  }),
  lifecycle: z.object({
    approvalEvents: z.literal(1),
    finalState: z.object({
      dispatches: z.object({ read: z.literal(1), update: z.literal(1), denied: z.literal(0) }),
    }).passthrough(),
    toolRecords: z.array(z.object({ modelRequestId: z.string() }).passthrough()).length(2),
    requestIds: z.array(z.string()).length(4),
    attempts: z.array(z.object({ state: z.literal('succeeded') }).passthrough()).length(4),
    invariantTraceEvents: z.literal(1),
    integrity: z.object({ status: z.literal('complete') }).passthrough(),
  }).passthrough(),
  assertions: z.array(z.object({ id: z.string(), passed: z.literal(true) }).passthrough()),
  verdict: z.object({
    correctedFixturePassed: z.literal(true),
    negativeControlDetected: z.literal(true),
    namedMismatches: z.array(z.string()).length(0),
  }),
}).passthrough();

export const unifiedToolPipelineScenario:
AssembledBehaviorScenario<UnifiedToolPipelineEvidenceBundle> = {
  id: E8_ASSEMBLED_SCENARIO_ID,
  title: 'Harness unified tool pipeline preserves decisions and results',
  why: 'Executes the real ModelRuntime, TurnToolExecutor, ToolsRegistry, durable E3/E4 adapters, E6 trace, and E7 usage path across allow, ask, deny, and invariant rejection.',
  run: runScenario,
};
