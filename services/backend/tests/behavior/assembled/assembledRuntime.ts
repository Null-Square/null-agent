import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { createStreamBroker } from '../../../src/app/factories/orchestration';
import { ToolsRegistryAdapter } from '../../../src/domains/agent-brain/adapters/ToolsRegistryAdapter';
import { ToolsRegistry } from '../../../src/domains/agent-brain/adapters/tools/ToolsRegistry';
import type { SandboxAdapter } from '../../../src/domains/agent-brain/adapters/sandbox';
import { SessionStore } from '../../../src/domains/agent-brain/application/core/SessionStore';
import { TurnToolExecutor } from '../../../src/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { StreamBroker as ToolCallStreamBroker } from '../../../src/domains/agent-brain/application/orchestration/streaming/StreamBroker';
import type { SessionState, StreamEvent } from '../../../src/domains/agent-brain/domain/types';
import { readInterruptedToolOutcome } from '../../../src/domains/agent-brain/domain/recovery/interruptedToolResult';
import { SessionTraceRecorder } from '../../../src/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';
import type { WorkspaceManager } from '../../../src/domains/agent-brain/ports';
import { DurableBehaviorStore } from './DurableBehaviorStore';
import { hydrateTrace } from './hydrateTrace';
import type {
  AssembledFixtureEvidence,
  AssembledFixtureKind,
  BehaviorMessageObservation,
  ModelRequestObservation,
  ProviderAttemptObservation,
  VerificationAssertion,
} from './types';

export const E0_ASSEMBLED_SCENARIO_ID =
  'harness-verification-gate-detects-hidden-runtime-failure';
export const E0_TOOL_NAME = 'behavior_neutral_effect';
export const E0_TOOL_CALL_ID = 'behavior-lab-tool-call-1';
export const E0_FAULT_POINT = 'after_neutral_external_effect_before_tool_terminal';
export const E0_ARTIFACT_INLINE_LIMIT = 160;

type FaultControllerGlobal = typeof globalThis & {
  __nullAiBehaviorFaultControllers?: Map<string, AbortController>;
};

type ExternalCounter = {
  count: number;
  effects: Array<{ toolCallId: string; recordedAt: string }>;
};

type ScriptedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type RuntimeInstance = {
  sessionId: string;
  sessionStore: SessionStore;
  traceRecorder: SessionTraceRecorder;
  executor: TurnToolExecutor;
  close: (terminal: 'session.done' | 'error') => Promise<void>;
};

const fixtureToolsDir = path.resolve(__dirname, 'fixtures', 'tools');

const now = (): string => new Date().toISOString();

const cloneSessionForPersistence = (session: SessionState): Record<string, unknown> =>
  JSON.parse(JSON.stringify(session, (key, value) => {
    if (key === 'stateMachine' || key === 'currentTurn') return undefined;
    return value;
  })) as Record<string, unknown>;

const restoreSession = (snapshot: Record<string, unknown>): SessionState =>
  JSON.parse(JSON.stringify(snapshot)) as SessionState;

const makeWorkspaceManager = (root: string): WorkspaceManager => ({
  allocateWorkspace(ownerId, options) {
    const prefix = options?.kind === 'run' ? 'ns-run' : 'ns-session';
    return path.join(root, 'workspaces', `${prefix}-${ownerId}`);
  },
  async ensureWorkspace(workspaceDir) {
    mkdirSync(workspaceDir, { recursive: true });
  },
  async cleanupWorkspace(workspaceDir) {
    rmSync(workspaceDir, { recursive: true, force: true });
  },
});

const createRuntime = async (input: {
  fixtureRoot: string;
  store: DurableBehaviorStore;
  sessionSnapshot?: Record<string, unknown>;
}): Promise<RuntimeInstance> => {
  const traceRoot = path.join(input.fixtureRoot, 'trace');
  const traceRecorder = new SessionTraceRecorder({
    rootDir: traceRoot,
    inlineLimit: E0_ARTIFACT_INLINE_LIMIT,
    stdoutChunkSize: 1024,
    compressOverBytes: 1024 * 1024,
    retentionDays: 1,
  });
  const sessionStore = new SessionStore({
    workspaceManager: makeWorkspaceManager(input.fixtureRoot),
    traceRecorder,
    sessionTTL: 60_000,
  });
  const streamBroker = createStreamBroker();
  const toolsRegistry = new ToolsRegistry(
    streamBroker,
    sessionStore,
    {} as SandboxAdapter,
    undefined,
    traceRecorder,
    {
      toolsDir: fixtureToolsDir,
      devWatch: false,
      toolExecutionDb: input.store,
    },
  );
  await toolsRegistry.whenReady();
  sessionStore.setToolSchemaProvider(() => toolsRegistry.getToolSchemas());

  let session: SessionState;
  if (input.sessionSnapshot) {
    session = restoreSession(input.sessionSnapshot);
    await sessionStore.setAsync(session.id, session, 'behavior_lab.cold_restart');
    await traceRecorder.init(session.id, {
      workspace: session.workspaceDir,
      tools: toolsRegistry.getToolSchemas().map((tool) => tool.name),
      profileKey: session.profileKey,
      promptProfile: session.promptProfile,
      agentType: session.agentType ?? 'chat',
      agentRole: 'behavior_lab_verifier',
      model: session.modelName ?? 'behavior-scripted-v1',
    });
  } else {
    session = await sessionStore.create({
      modelName: 'behavior-scripted-v1',
      modelContextWindow: 16_384,
      modelMaxOutputTokens: 512,
      mode: 'automated',
      agentType: 'executor',
      promptProfile: 'executor',
      toolPolicy: { allow: ['*'] },
      flags: {
        behaviorLab: {
          scenarioId: E0_ASSEMBLED_SCENARIO_ID,
          host: 'behavior_lab_assembled',
        },
      },
    });
    await traceRecorder.init(session.id, {
      workspace: session.workspaceDir,
      tools: toolsRegistry.getToolSchemas().map((tool) => tool.name),
      profileKey: session.profileKey,
      promptProfile: session.promptProfile,
      agentType: session.agentType ?? 'chat',
      agentRole: 'behavior_lab_verifier',
      model: session.modelName ?? 'behavior-scripted-v1',
    });
  }

  const executor = new TurnToolExecutor({
    sessionStore,
    toolsRegistry: new ToolsRegistryAdapter(toolsRegistry),
  });

  return {
    sessionId: session.id,
    sessionStore,
    traceRecorder,
    executor,
    async close(terminal) {
      await traceRecorder.close(session.id, {
        terminal,
        status: terminal === 'error' ? 'interrupted' : 'closed',
      });
      sessionStore.shutdown();
    },
  };
};

class DeterministicScriptedProvider {
  readonly name = 'behavior-scripted-provider';
  readonly model = 'behavior-scripted-v1';

  dispatch(input: {
    store: DurableBehaviorStore;
    sessionId: string;
    turn: number;
    toolArguments: Record<string, unknown>;
  }): ScriptedToolCall {
    const requestId = `request-${input.turn}`;
    const toolCall: ScriptedToolCall = {
      id: E0_TOOL_CALL_ID,
      name: E0_TOOL_NAME,
      arguments: input.toolArguments,
    };
    const request: ModelRequestObservation = {
      requestId,
      sessionId: input.sessionId,
      turn: input.turn,
      provider: this.name,
      model: this.model,
      messages: [{
        role: 'user',
        content: 'Execute the neutral verification effect exactly once.',
      }],
      tools: [{
        name: E0_TOOL_NAME,
        schema: {
          type: 'object',
          required: ['counterPath', 'faultPoint', 'faultToken', 'toolCallId'],
        },
      }],
      recordedAt: now(),
    };
    const attempt: ProviderAttemptObservation = {
      attemptId: `attempt-${input.turn}`,
      requestId,
      provider: this.name,
      model: this.model,
      ordinal: 1,
      status: 'completed',
      toolCalls: [toolCall],
      usage: {
        inputTokens: 24,
        outputTokens: 18,
      },
      recordedAt: now(),
    };
    input.store.appendModelRequest(request);
    input.store.appendProviderAttempt(attempt);
    input.store.appendMessage({
      id: `message-user-${input.turn}`,
      role: 'user',
      content: request.messages[0]!.content,
      recordedAt: now(),
    });
    input.store.appendMessage({
      id: `message-assistant-${input.turn}`,
      role: 'assistant',
      toolCalls: [toolCall],
      recordedAt: now(),
    });
    return toolCall;
  }
}

const runProviderTurn = async (input: {
  runtime: RuntimeInstance;
  store: DurableBehaviorStore;
  provider: DeterministicScriptedProvider;
  turn: number;
  counterPath: string;
  faultToken: string;
}): Promise<{ error?: string; streamEvents: StreamEvent[] }> => {
  const controller = new AbortController();
  const globals = globalThis as FaultControllerGlobal;
  globals.__nullAiBehaviorFaultControllers ??= new Map<string, AbortController>();
  globals.__nullAiBehaviorFaultControllers.set(input.faultToken, controller);
  const toolCall = input.provider.dispatch({
    store: input.store,
    sessionId: input.runtime.sessionId,
    turn: input.turn,
    toolArguments: {
      counterPath: input.counterPath,
      faultPoint: E0_FAULT_POINT,
      faultToken: input.faultToken,
      toolCallId: E0_TOOL_CALL_ID,
    },
  });
  const streamEvents: StreamEvent[] = [];
  const stream = new ToolCallStreamBroker((event) => streamEvents.push(event));
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]): void => {
    const expectedSettlementFault = values.some((value) =>
      (value instanceof Error
        && value.message.includes('behavior_lab_named_fault:terminal_settlement_unavailable'))
      || String(value).includes('[ToolsRegistry] Failed to record tool failure'));
    if (!expectedSettlementFault) originalWarn(...values);
  };

  try {
    const execution = await input.runtime.executor.run({
      sessionId: input.runtime.sessionId,
      abortSignal: controller.signal,
      toolCalls: [{
        id: toolCall.id,
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }],
      stream,
      turnNumber: input.turn,
      maxToolCalls: 1,
    });
    for (const message of execution.collectedToolResults) {
      const observation: BehaviorMessageObservation = {
        id: message.id,
        role: 'tool',
        content: message.content,
        toolCallId: message.toolCallId,
        recordedAt: now(),
      };
      input.store.appendMessage(observation);
    }
    input.store.appendTerminalState({
      sessionId: input.runtime.sessionId,
      state: execution.collectedToolResults.some((message) =>
        readInterruptedToolOutcome(message.content)?.kind === 'outcome_unknown')
        ? 'recovered_unknown'
        : 'completed',
      recordedAt: now(),
    });
    return { streamEvents };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.store.appendTerminalState({
      sessionId: input.runtime.sessionId,
      state: 'interrupted',
      reason: message,
      recordedAt: now(),
    });
    return { error: message, streamEvents };
  } finally {
    console.warn = originalWarn;
    globals.__nullAiBehaviorFaultControllers.delete(input.faultToken);
  }
};

const readExternalCounter = (counterPath: string): ExternalCounter => {
  if (!existsSync(counterPath)) return { count: 0, effects: [] };
  return JSON.parse(readFileSync(counterPath, 'utf8')) as ExternalCounter;
};

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  authoritativeSource: string,
  detail: string,
): VerificationAssertion => ({
  id,
  passed,
  expected,
  actual,
  authoritativeSource,
  detail,
});

const parseToolMessage = (content: string | undefined): Record<string, unknown> => {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export const runAssembledFixture = async (
  fixture: AssembledFixtureKind,
): Promise<AssembledFixtureEvidence> => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'null-ai-behavior-e0-'));
  const storePath = path.join(fixtureRoot, 'durable', 'behavior-store.json');
  const counterPath = path.join(fixtureRoot, 'external', 'neutral-counter.json');
  const faultToken = uuidv4();
  const provider = new DeterministicScriptedProvider();
  let firstRuntime: RuntimeInstance | undefined;
  let recoveryRuntime: RuntimeInstance | undefined;

  try {
    const firstStore = new DurableBehaviorStore(storePath, { rejectTerminalSettlement: true });
    firstRuntime = await createRuntime({ fixtureRoot, store: firstStore });
    const sessionId = firstRuntime.sessionId;
    const firstRun = await runProviderTurn({
      runtime: firstRuntime,
      store: firstStore,
      provider,
      turn: 1,
      counterPath,
      faultToken,
    });
    const liveSession = firstRuntime.sessionStore.get(firstRuntime.sessionId);
    if (!liveSession) throw new Error('behavior_lab_session_missing_before_restart');
    firstStore.saveSessionSnapshot(cloneSessionForPersistence(liveSession));
    const authoritativeBeforeRestart = firstStore.snapshot().toolExecutions;
    await firstRuntime.close('error');
    firstRuntime = undefined;

    if (fixture === 'broken-authoritative-omission') {
      firstStore.omitToolExecutionForNegativeControl(
        E0_TOOL_CALL_ID,
        'Deliberately omit the authoritative claim while retaining the provider projection.',
      );
    }

    const recoveryStore = new DurableBehaviorStore(storePath, { rejectTerminalSettlement: true });
    const authoritativeAtColdStart = recoveryStore.snapshot().toolExecutions;
    const snapshot = recoveryStore.loadSessionSnapshot();
    if (!snapshot) throw new Error('behavior_lab_session_snapshot_missing');
    recoveryRuntime = await createRuntime({
      fixtureRoot,
      store: recoveryStore,
      sessionSnapshot: snapshot,
    });
    const recoveryRun = await runProviderTurn({
      runtime: recoveryRuntime,
      store: recoveryStore,
      provider,
      turn: 2,
      counterPath,
      faultToken,
    });
    await recoveryRuntime.close(recoveryRun.error ? 'error' : 'session.done');
    recoveryRuntime = undefined;

    const durable = recoveryStore.snapshot();
    const externalState = readExternalCounter(counterPath);
    const hydrated = hydrateTrace(path.join(fixtureRoot, 'trace'), sessionId);
    const firstAttempt = durable.providerAttempts[0];
    const legacyFirstToolAssertionPassed =
      firstAttempt?.toolCalls[0]?.name === E0_TOOL_NAME;
    const recoveryToolMessage = [...durable.messages]
      .reverse()
      .find((message) => message.role === 'tool' && message.toolCallId === E0_TOOL_CALL_ID);
    const recoveryPayload = parseToolMessage(recoveryToolMessage?.content);
    const coldRecord = authoritativeAtColdStart.find(
      (record) => record.toolCallId === E0_TOOL_CALL_ID,
    );
    const artifactEvents = hydrated.trace.filter((event) => event.payloadMode === 'artifact');
    const hydratedArtifactEvents = artifactEvents.filter(
      (event) => typeof event.hydratedPayload !== 'undefined',
    );
    const toolStarts = hydrated.trace.filter(
      (event) => event.event === 'tool.start' && event.toolCallId === E0_TOOL_CALL_ID,
    );
    const requestsJoined = durable.modelRequests.length === 2
      && durable.providerAttempts.length === 2
      && durable.providerAttempts.every((attempt) =>
        durable.modelRequests.some((request) => request.requestId === attempt.requestId));
    const lastTerminal = durable.terminalStates.at(-1)?.state;

    const assertions: VerificationAssertion[] = [
      assertion(
        'projection.legacy_first_tool_call',
        legacyFirstToolAssertionPassed,
        E0_TOOL_NAME,
        firstAttempt?.toolCalls[0]?.name,
        'behavior-store.json#/providerAttempts/0/toolCalls/0',
        'The legacy model-choice projection still sees the expected first tool.',
      ),
      assertion(
        'persistence.request_attempt_join',
        requestsJoined,
        'two durable requests joined to two durable attempts',
        {
          requests: durable.modelRequests.map((request) => request.requestId),
          attempts: durable.providerAttempts.map((attempt) => ({
            attemptId: attempt.attemptId,
            requestId: attempt.requestId,
          })),
        },
        'behavior-store.json#/modelRequests + /providerAttempts',
        'The deterministic provider request is durable before dispatch and every attempt joins it.',
      ),
      assertion(
        'authoritative.tool_execution_claim_survived_cold_restart',
        coldRecord?.status === 'pending',
        { toolCallId: E0_TOOL_CALL_ID, status: 'pending' },
        coldRecord ?? null,
        'behavior-store.json#/toolExecutions',
        'Cold recovery must observe the pre-effect execution claim in the authoritative ledger.',
      ),
      assertion(
        'recovery.pending_execution_is_reported_unknown',
        recoveryPayload.toolExecutionUncertain === true
          && recoveryPayload.executionStatus === 'outcome_unknown',
        { toolExecutionUncertain: true, executionStatus: 'outcome_unknown' },
        recoveryPayload,
        'behavior-store.json#/messages[role=tool]',
        'The shipping tool path must refuse to replay an execution whose outcome is unknown.',
      ),
      assertion(
        'external.neutral_effect_executed_once',
        externalState.count === 1,
        1,
        externalState.count,
        'neutral-counter.json#/count',
        'Cold recovery must not repeat the neutral external effect.',
      ),
      assertion(
        'trace.artifact_links_fully_hydrated',
        artifactEvents.length > 0 && artifactEvents.length === hydratedArtifactEvents.length,
        'at least one offloaded event and no unresolved artifact links',
        {
          artifactEvents: artifactEvents.length,
          hydratedArtifactEvents: hydratedArtifactEvents.length,
        },
        'trace.ndjson + trace/artifacts/*',
        'Assertions inspect hydrated payloads rather than treating inline links as complete records.',
      ),
      assertion(
        'trace.tool_starts_match_external_effects',
        toolStarts.length === externalState.count,
        externalState.count,
        toolStarts.length,
        'hydrated trace tool.start + neutral-counter.json#/count',
        'Trace and neutral external state must correlate after artifact hydration.',
      ),
      assertion(
        'terminal.cold_recovery_settled_as_unknown',
        lastTerminal === 'recovered_unknown',
        'recovered_unknown',
        lastTerminal,
        'behavior-store.json#/terminalStates',
        'The cold run terminates with an honest unknown outcome instead of invented success.',
      ),
    ];

    return {
      fixture,
      legacyFirstToolAssertionPassed,
      newGatePassed: assertions.every((entry) => entry.passed),
      namedFaultPoint: E0_FAULT_POINT,
      coldRestartPerformed: true,
      firstRunError: firstRun.error,
      recoveryRunError: recoveryRun.error,
      authoritativeBeforeRestart,
      authoritativeAtColdStart,
      durable,
      trace: hydrated.trace,
      artifacts: hydrated.artifacts,
      externalState,
      assertions,
    };
  } finally {
    if (firstRuntime) await firstRuntime.close('error').catch(() => undefined);
    if (recoveryRuntime) await recoveryRuntime.close('error').catch(() => undefined);
    const globals = globalThis as FaultControllerGlobal;
    globals.__nullAiBehaviorFaultControllers?.delete(faultToken);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};
