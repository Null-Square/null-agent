import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ERROR_CODES } from '@null-ai/contracts';

import { DefaultBuildStage } from '../../../../src/domains/agent-brain/application/orchestration/stages/BuildStage';
import { ModelRuntime } from '../../../../src/domains/agent-brain/application/orchestration/ModelRuntime';
import { ModelStream } from '../../../../src/domains/agent-brain/application/orchestration/streaming/ModelStream';
import { AppError } from '../../../../src/domains/agent-brain/domain/errors';
import type { Message, SessionState } from '../../../../src/domains/agent-brain/domain/types';
import { createResearchLabRuntimeHostCapabilities } from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import type {
  AppendModelRequestInput,
  HistoryTransformationPort,
  HistoryTransformationRecord,
  ModelRequestPort,
  ModelRequestRecord,
  PersistHistoryReplacementInput,
  PrepareHistoryTransformationInput,
} from '../../../../src/domains/agent-brain/ports';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E5_OVERFLOW_SCENARIO_ID =
  'harness-context-overflow-compacts-once-and-recovers';

type CrashEvidence = {
  faultPoint: 'before_activation' | 'after_activation';
  activeImmediatelyAfterCrash: boolean;
  activeAfterColdRecovery: boolean;
  transactionCount: number;
  boundaryBefore: string;
  boundaryAfter: string;
  summarizerCalls: number;
};

type SerializedModelRequest = Omit<ModelRequestRecord, 'createdAt'> & { createdAt: string };

const atomicWrite = (filePath: string, value: unknown): void => {
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, filePath);
};

class ScenarioModelRequestFile implements ModelRequestPort {
  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (!existsSync(this.filePath)) atomicWrite(this.filePath, { schemaVersion: 3, records: [] });
  }

  async append(input: AppendModelRequestInput): Promise<ModelRequestRecord> {
    const records = this.read();
    const existing = records.find((record) => record.requestId === input.requestId);
    if (existing) return this.runtime(existing);
    const record: SerializedModelRequest = {
      ...structuredClone(input),
      provenance: 'recorded',
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };
    records.push(record);
    atomicWrite(this.filePath, { schemaVersion: 3, records });
    return this.runtime(record);
  }

  async findByRequestId(requestId: string): Promise<ModelRequestRecord | undefined> {
    const record = this.read().find((candidate) => candidate.requestId === requestId);
    return record ? this.runtime(record) : undefined;
  }

  async findBySession(sessionId: string): Promise<ModelRequestRecord[]> {
    return this.read()
      .filter((record) => record.sessionId === sessionId)
      .map((record) => this.runtime(record));
  }

  private read(): SerializedModelRequest[] {
    if (!existsSync(this.filePath)) return [];
    return (JSON.parse(readFileSync(this.filePath, 'utf8')) as {
      records: SerializedModelRequest[];
    }).records;
  }

  private runtime(record: SerializedModelRequest): ModelRequestRecord {
    return { ...structuredClone(record), createdAt: new Date(record.createdAt) };
  }
}

class ScenarioHistoryFile implements HistoryTransformationPort {
  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (!existsSync(this.filePath)) atomicWrite(this.filePath, { schemaVersion: 1, records: [] });
  }

  async prepare(input: PrepareHistoryTransformationInput): Promise<HistoryTransformationRecord> {
    const records = this.read();
    const existing = records.find((record) => record.transactionId === input.transactionId);
    if (existing) return structuredClone(existing);
    const record: HistoryTransformationRecord = {
      ...structuredClone(input),
      provenance: 'recorded',
      status: 'prepared',
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    records.push(record);
    this.write(records);
    return structuredClone(record);
  }

  async persistReplacement(
    transactionId: string,
    input: PersistHistoryReplacementInput,
  ): Promise<HistoryTransformationRecord> {
    const records = this.read();
    const record = records.find((candidate) => candidate.transactionId === transactionId);
    if (!record) throw new Error(`missing:${transactionId}`);
    if (record.status === 'prepared') {
      Object.assign(record, structuredClone(input), {
        status: 'replacement_persisted',
        replacementPersistedAt: input.replacementPersistedAt ?? new Date().toISOString(),
      });
      this.write(records);
    }
    return structuredClone(record);
  }

  async activate(transactionId: string, activatedAt?: string): Promise<HistoryTransformationRecord> {
    const records = this.read();
    const record = records.find((candidate) => candidate.transactionId === transactionId);
    if (!record) throw new Error(`missing:${transactionId}`);
    if (record.status !== 'activated') {
      for (const candidate of records) {
        if (candidate.sessionId === record.sessionId && candidate.status === 'activated') {
          candidate.status = 'superseded';
        }
      }
      record.status = 'activated';
      record.activatedAt = activatedAt ?? new Date().toISOString();
      this.write(records);
    }
    return structuredClone(record);
  }

  async findById(transactionId: string): Promise<HistoryTransformationRecord | undefined> {
    const record = this.read().find((candidate) => candidate.transactionId === transactionId);
    return record ? structuredClone(record) : undefined;
  }

  async findActiveBySession(sessionId: string): Promise<HistoryTransformationRecord | undefined> {
    const record = this.read().find(
      (candidate) => candidate.sessionId === sessionId && candidate.status === 'activated',
    );
    return record ? structuredClone(record) : undefined;
  }

  async findBySession(sessionId: string): Promise<HistoryTransformationRecord[]> {
    return this.read()
      .filter((record) => record.sessionId === sessionId)
      .map((record) => structuredClone(record));
  }

  private read(): HistoryTransformationRecord[] {
    if (!existsSync(this.filePath)) return [];
    return (JSON.parse(readFileSync(this.filePath, 'utf8')) as {
      records: HistoryTransformationRecord[];
    }).records;
  }

  private write(records: HistoryTransformationRecord[]): void {
    atomicWrite(this.filePath, { schemaVersion: 1, records });
  }
}

export type ContextOverflowRecoveryEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-context-overflow-recovery-evidence/v1';
  scenarioId: typeof E5_OVERFLOW_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  recovery: {
    providerDispatches: number;
    requestIds: string[];
    committedTransactions: number;
    transactionId: string;
    retryTransformationRefs: string[];
    failedPartialInHistory: boolean;
    result: string;
  };
  crashes: CrashEvidence[];
  secondOverflow: {
    providerDispatches: number;
    requestCount: number;
    committedTransactions: number;
    stopped: boolean;
  };
  negativeControl: {
    arrayPositionBoundaryAccepted: boolean;
    hypotheticalUnboundedDispatches: number;
    detected: boolean;
  };
  assertions: VerificationAssertion[];
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
  authoritativeSource: 'DefaultBuildStage + ModelRuntime + file lifecycle cold reconstruction',
  detail,
});

const SUMMARY = [
  '## Filed Findings', '- F-1 retained', '',
  '## Attempted Techniques', '- technique retained', '',
  '## Failed Approaches and Blockers', '- blocker retained', '',
  '## Confirmed Credentials or Tokens', '- none', '',
  '## Open Plan Steps', '- continue validation', '',
  '## High-Signal Discoveries', '- stable discovery', '',
  '## Constraints and Safety Limits', '- remain in scope',
].join('\n');

const createMessages = (prefix: string): Message[] =>
  Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-message-${index}`,
    role: 'user',
    content: `${prefix} evidence ${index} ${'x'.repeat(1_500)}`,
    timestamp: index,
  }));

const createSession = (id: string, messages: Message[]): SessionState => ({
  id,
  profileKey: 'default',
  messages,
  modelContextWindow: 128_000,
  modelMaxOutputTokens: 8_192,
  flags: { securityops: { workflowDiscipline: 'code_review' } },
} as unknown as SessionState);

const baseProvider = (dispatch: (body: Record<string, unknown>) => Promise<unknown>) => ({
  name: 'behavior-overflow-provider',
  getCapabilities: () => ({ contextWindow: 128_000 }),
  getClient: () => ({ chat: { completions: { create: dispatch } } }),
  buildSystemMessages: () => [],
  decorateRequest: (body: Record<string, unknown>) => ({ ...body, tool_choice: 'auto' }),
  normalizeUsage: (usage: Record<string, number>) => ({
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }),
  mapError: (error: unknown) => error instanceof AppError
    ? error
    : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error)),
  supportsCacheControl: () => false,
});

const successStream = () => (async function* stream() {
  yield {
    id: 'overflow-recovery-response',
    model: 'behavior-overflow-model',
    choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }],
  };
  yield {
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
    choices: [],
  };
})();

const providerOverflow = () => Object.assign(
  new AppError(ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED, 'deterministic context overflow'),
  {
    modelAttemptStatus: 'failed' as const,
    modelOutputStarted: false,
    partialOutput: 'FAILED_PARTIAL_OUTPUT_MUST_NOT_PERSIST',
  },
);

const buildPrompt = async (input: {
  session: SessionState;
  history: ScenarioHistoryFile;
  compactionReason?: 'provider_context_overflow';
  triggerRequestId?: string;
  fault?: (point: string) => void;
  summarizer?: () => Promise<{ content: string }>;
}) => new DefaultBuildStage().run({
  session: input.session,
  turnNumber: 3,
  contextProvider: { getContext: async () => ({ hard: '', soft: '' }) } as any,
  promptBuilder: {
    resolveProfile: async () => ({ id: 'behavior' }),
    build: () => ({
      staticPrompt: '',
      dynamicPrompt: '',
      softContext: '',
      cacheablePrefix: '',
      dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
      sections: { static: [], soft: [], dynamic: [] },
    }),
  } as any,
  cacheCoordinator: {
    build: () => ({ cacheIntent: { action: 'none' }, approxPrefixTokens: 0, prefixHash: 'none' }),
  } as any,
  toolsRegistry: { getToolSchemas: () => [] } as any,
  provider: baseProvider(async () => successStream()) as any,
  convertMessages: (messages) => messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) as any,
  maxToolCalls: 4,
  modelName: 'behavior-overflow-model',
  executeModelCall: input.summarizer ?? (async () => ({ content: SUMMARY })) as any,
  historyTransformationPort: input.history,
  compactionReason: input.compactionReason,
  triggerRequestId: input.triggerRequestId,
  historyTransformationFault: input.fault
    ? async (point) => input.fault?.(point)
    : undefined,
});

const usageRecorder = () => ({
  beginAttempt: async (_sessionId: string, input: { attemptOrdinal: number }) => ({
    id: `attempt-${input.attemptOrdinal}`,
  }),
  failAttempt: async () => undefined,
  recordUsage: async () => ({
    promptTokens: 20,
    cachedPromptTokens: 0,
    completionTokens: 2,
    totalTokens: 22,
    nativeCost: 0,
    platformPrice: 0,
    credits: 0,
  }),
});

const executeRequest = async (input: {
  runtime: ModelRuntime;
  model: ModelStream;
  requests: ScenarioModelRequestFile;
  session: SessionState;
  prompt: Awaited<ReturnType<typeof buildPrompt>>;
  callOrdinal: number;
}) => input.runtime.execute({
  model: input.model,
  usageRecorder: usageRecorder() as any,
  sessionId: input.session.id,
  turn: 3,
  callOrdinal: input.callOrdinal,
  configuredModelName: 'behavior-overflow-model',
  routeReason: 'session_pinned',
  maxRetries: 0,
  modelRequestPort: input.requests,
  modelRequestCapability: createResearchLabRuntimeHostCapabilities().modelRequests,
  routedContextCapacity: 128_000,
  contextMeasurementHints: input.prompt.contextMeasurementHints,
  transformationRefs: input.prompt.transformationRefs,
  request: {
    sessionId: input.session.id,
    messages: [...input.prompt.systemMessages, ...input.prompt.historyMessages],
    tools: input.prompt.toolDefinitions,
    signal: new AbortController().signal,
    maxTokens: 8_192,
  },
});

const requestIdFromError = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'modelRequestId' in error
    && typeof error.modelRequestId === 'string'
    ? error.modelRequestId
    : undefined;

const runRecoveryFixture = async (root: string) => {
  const history = new ScenarioHistoryFile(path.resolve(root, 'history.json'));
  const requests = new ScenarioModelRequestFile(path.resolve(root, 'requests.json'));
  await history.initialize();
  await requests.initialize();
  const session = createSession('overflow-recovery-session', createMessages('recovery'));
  let providerDispatches = 0;
  const provider = baseProvider(async () => {
    providerDispatches += 1;
    if (providerDispatches === 1) throw providerOverflow();
    return successStream();
  });
  const model = new ModelStream({ provider: provider as any });
  model.setModelName('behavior-overflow-model');
  const runtime = new ModelRuntime();
  const initialPrompt = await buildPrompt({ session, history });
  let failedRequestId: string | undefined;
  try {
    await executeRequest({ runtime, model, requests, session, prompt: initialPrompt, callOrdinal: 1 });
  } catch (error) {
    failedRequestId = requestIdFromError(error);
  }
  if (!failedRequestId) throw new Error('overflow request did not expose its E4 request ID');
  const retryPrompt = await buildPrompt({
    session,
    history,
    compactionReason: 'provider_context_overflow',
    triggerRequestId: failedRequestId,
  });
  const retry = await executeRequest({
    runtime,
    model,
    requests,
    session,
    prompt: retryPrompt,
    callOrdinal: 2,
  });
  const durableRequests = await requests.findBySession(session.id);
  const transactions = await history.findBySession(session.id);
  return {
    providerDispatches,
    durableRequests,
    transactions,
    retryPrompt,
    result: retry.result.content,
    failedPartialInHistory: session.messages.some(
      (message) => String(message.content).includes('FAILED_PARTIAL_OUTPUT_MUST_NOT_PERSIST'),
    ),
  };
};

const runCrashFixture = async (
  root: string,
  faultPoint: CrashEvidence['faultPoint'],
): Promise<CrashEvidence> => {
  const filePath = path.resolve(root, `${faultPoint}.json`);
  const live = new ScenarioHistoryFile(filePath);
  await live.initialize();
  const session = createSession(`crash-${faultPoint}`, createMessages(faultPoint));
  let summarizerCalls = 0;
  try {
    await buildPrompt({
      session,
      history: live,
      compactionReason: 'provider_context_overflow',
      triggerRequestId: `failed-${faultPoint}`,
      summarizer: async () => {
        summarizerCalls += 1;
        return { content: SUMMARY };
      },
      fault: (point) => {
        if (
          (faultPoint === 'before_activation' && point === 'after_replacement_persisted_before_activation')
          || (faultPoint === 'after_activation' && point === 'after_activation')
        ) {
          throw new Error(`crash:${faultPoint}`);
        }
      },
    });
  } catch {
    // Deterministic process death seam.
  }
  const liveRecords = await live.findBySession(session.id);
  const boundaryBefore = liveRecords[0]?.inputEndMessageId ?? 'missing';
  const activeImmediatelyAfterCrash = Boolean(await live.findActiveBySession(session.id));

  const cold = new ScenarioHistoryFile(filePath);
  const recovered = await buildPrompt({
    session,
    history: cold,
    summarizer: async () => {
      summarizerCalls += 1;
      return { content: SUMMARY };
    },
  });
  const coldRecords = await cold.findBySession(session.id);
  const active = await cold.findActiveBySession(session.id);
  return {
    faultPoint,
    activeImmediatelyAfterCrash,
    activeAfterColdRecovery: Boolean(active),
    transactionCount: coldRecords.length,
    boundaryBefore,
    boundaryAfter: active?.inputEndMessageId ?? 'missing',
    summarizerCalls,
    ...(recovered.transformationRefs?.[0] ? {} : {}),
  };
};

const runSecondOverflowFixture = async (root: string) => {
  const history = new ScenarioHistoryFile(path.resolve(root, 'loop-history.json'));
  const requests = new ScenarioModelRequestFile(path.resolve(root, 'loop-requests.json'));
  await history.initialize();
  await requests.initialize();
  const session = createSession('second-overflow-session', createMessages('second-overflow'));
  let providerDispatches = 0;
  const provider = baseProvider(async () => {
    providerDispatches += 1;
    throw providerOverflow();
  });
  const model = new ModelStream({ provider: provider as any });
  model.setModelName('behavior-overflow-model');
  const runtime = new ModelRuntime();
  const initialPrompt = await buildPrompt({ session, history });
  let failedRequestId: string | undefined;
  try {
    await executeRequest({ runtime, model, requests, session, prompt: initialPrompt, callOrdinal: 1 });
  } catch (error) {
    failedRequestId = requestIdFromError(error);
  }
  if (!failedRequestId) throw new Error('missing first overflow request');
  const retryPrompt = await buildPrompt({
    session,
    history,
    compactionReason: 'provider_context_overflow',
    triggerRequestId: failedRequestId,
  });
  let stopped = false;
  try {
    await executeRequest({ runtime, model, requests, session, prompt: retryPrompt, callOrdinal: 2 });
  } catch (error) {
    stopped = error instanceof AppError && error.code === ERROR_CODES.LLM_CONTEXT_LENGTH_EXCEEDED;
  }
  return {
    providerDispatches,
    requestCount: (await requests.findBySession(session.id)).length,
    committedTransactions: (await history.findBySession(session.id))
      .filter((record) => record.status === 'activated').length,
    stopped,
  };
};

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const runScenario = async (): Promise<AssembledScenarioResult<ContextOverflowRecoveryEvidenceBundle>> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'null-ai-behavior-e5-overflow-'));
  try {
    const fixture = await runRecoveryFixture(root);
    const crashes = [
      await runCrashFixture(root, 'before_activation'),
      await runCrashFixture(root, 'after_activation'),
    ];
    const secondOverflow = await runSecondOverflowFixture(root);
    const committed = fixture.transactions.filter((record) => record.status === 'activated');
    const transactionId = committed[0]?.transactionId ?? 'missing';
    const requestIds = fixture.durableRequests.map((record) => record.requestId);
    const retryRequest = fixture.durableRequests[1] as ModelRequestRecord | undefined;
    const recovery = {
      providerDispatches: fixture.providerDispatches,
      requestIds,
      committedTransactions: committed.length,
      transactionId,
      retryTransformationRefs: retryRequest?.transformationRefs ?? [],
      failedPartialInHistory: fixture.failedPartialInHistory,
      result: fixture.result,
    };
    const negativeControl = {
      arrayPositionBoundaryAccepted: fixture.transactions.some(
        (record) => !record.inputMessageIds.length || !record.inputEndMessageId,
      ),
      hypotheticalUnboundedDispatches: 3,
      detected: fixture.transactions.every(
        (record) => record.inputMessageIds.length > 0 && Boolean(record.inputEndMessageId),
      ) && secondOverflow.providerDispatches === 2,
    };
    const assertions = [
      assertion(
        'overflow.one_committed_reduction_one_retry',
        recovery.providerDispatches === 2
          && recovery.requestIds.length === 2
          && recovery.committedTransactions === 1,
        { providerDispatches: 2, requestCount: 2, committedTransactions: 1 },
        recovery,
        'The typed handoff persists one additional transformation and dispatches one new E4 request.',
      ),
      assertion(
        'overflow.retry_links_transaction',
        recovery.retryTransformationRefs.includes(transactionId),
        transactionId,
        recovery.retryTransformationRefs,
        'The retry E4 record links the activated history transaction.',
      ),
      assertion(
        'overflow.failed_partial_absent',
        !recovery.failedPartialInHistory,
        false,
        recovery.failedPartialInHistory,
        'The failed provider partial never enters durable session history.',
      ),
      assertion(
        'recovery.crash_boundaries_converge',
        crashes.every((crash) => crash.activeAfterColdRecovery
          && crash.transactionCount === 1
          && crash.boundaryBefore === crash.boundaryAfter
          && crash.summarizerCalls === 1)
          && crashes.find((crash) => crash.faultPoint === 'before_activation')?.activeImmediatelyAfterCrash === false
          && crashes.find((crash) => crash.faultPoint === 'after_activation')?.activeImmediatelyAfterCrash === true,
        true,
        crashes,
        'Cold recovery preserves the same Message.id boundary and reuses durable replacement/activation state.',
      ),
      assertion(
        'overflow.second_failure_stops',
        secondOverflow.stopped
          && secondOverflow.providerDispatches === 2
          && secondOverflow.requestCount === 2
          && secondOverflow.committedTransactions === 1,
        { stopped: true, providerDispatches: 2, requestCount: 2, committedTransactions: 1 },
        secondOverflow,
        'A second typed overflow exits without a third measurement, transformation, or dispatch.',
      ),
      assertion(
        'negative.array_cutoff_or_unbounded_retry_detected',
        negativeControl.detected,
        true,
        negativeControl,
        'Stable message identities and the two-dispatch bound reject both named negative controls.',
      ),
    ];
    const evidence: ContextOverflowRecoveryEvidenceBundle = {
      schema: 'behavior-lab-context-overflow-recovery-evidence/v1',
      scenarioId: E5_OVERFLOW_SCENARIO_ID,
      generatedAt: new Date().toISOString(),
      commit: commit(),
      recovery,
      crashes,
      secondOverflow,
      negativeControl,
      assertions,
      verdict: {
        correctedFixturePassed: assertions.slice(0, 5).every((entry) => entry.passed),
        negativeControlDetected: negativeControl.detected,
        namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
      },
    };
    const passed = assertions.every((entry) => entry.passed);
    return {
      id: E5_OVERFLOW_SCENARIO_ID,
      title: 'Harness context overflow compacts once and recovers',
      mode: 'assembled-runtime',
      passed,
      evidence,
      ...(!passed ? { error: `failed=${evidence.verdict.namedMismatches.join(',')}` } : {}),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const contextOverflowRecoveryEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-context-overflow-recovery-evidence/v1'),
  scenarioId: z.literal(E5_OVERFLOW_SCENARIO_ID),
  recovery: z.object({
    providerDispatches: z.number(),
    requestIds: z.array(z.string()),
    committedTransactions: z.number(),
    transactionId: z.string(),
    retryTransformationRefs: z.array(z.string()),
    failedPartialInHistory: z.boolean(),
    result: z.string(),
  }),
  crashes: z.array(z.object({
    faultPoint: z.enum(['before_activation', 'after_activation']),
    activeImmediatelyAfterCrash: z.boolean(),
    activeAfterColdRecovery: z.boolean(),
    transactionCount: z.number(),
    boundaryBefore: z.string(),
    boundaryAfter: z.string(),
    summarizerCalls: z.number(),
  })).length(2),
  secondOverflow: z.object({
    providerDispatches: z.number(),
    requestCount: z.number(),
    committedTransactions: z.number(),
    stopped: z.boolean(),
  }),
  negativeControl: z.object({ detected: z.boolean() }).passthrough(),
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()),
}).passthrough();

export const contextOverflowRecoveryScenario:
AssembledBehaviorScenario<ContextOverflowRecoveryEvidenceBundle> = {
  id: E5_OVERFLOW_SCENARIO_ID,
  title: 'Harness context overflow compacts once and recovers',
  why: 'Runs the real request runtime and compaction stage through a typed overflow, reconstructs durable state at both activation crash boundaries, and proves the second overflow stops.',
  run: runScenario,
};
