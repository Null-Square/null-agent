import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { ModelRuntime } from '../../../../src/domains/agent-brain/application/orchestration/ModelRuntime';
import { canonicalizeModelRequestEnvelope } from '../../../../src/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import { UsageRecorder } from '../../../../src/domains/agent-brain/infrastructure/usage/UsageRecorder';
import {
  buildProviderAttemptIntegrityExpectations,
  reconcileTraceIntegrity,
} from '../../../../src/domains/agent-brain/infrastructure/telemetry/TraceIntegrity';
import { SessionTraceRecorder } from '../../../../src/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';
import { InMemoryUsageStore } from '../../../../src/domains/platform/subscriptions/infrastructure/usageStores';
import type { ModelAttemptRecord } from '../../../../src/domains/agent-brain/ports';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E7_ASSEMBLED_SCENARIO_ID = 'harness-provider-retry-keeps-one-logical-request';

type FixtureMode = 'retry_success' | 'non_retryable' | 'cancelled_late_result';

type FixtureResult = {
  mode: FixtureMode;
  requestIds: string[];
  attempts: ModelAttemptRecord[];
  providerDispatches: number;
  toolCalls: Array<{ id: string; name: string }>;
  traceAttemptHeaders: Array<{
    requestId?: string;
    attemptId?: string;
    attemptOrdinal?: number;
    status?: string;
  }>;
  traceAcceptedHighWater: number;
  error?: string;
};

export type ProviderAttemptAccountingEvidenceBundle = {
  schema: 'behavior-lab-provider-attempt-accounting-evidence/v1';
  scenarioId: typeof E7_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  corrected: FixtureResult & {
    usageTotals: {
      uncachedInput: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      reasoning: number;
    };
    integrity: ReturnType<typeof reconcileTraceIntegrity>;
  };
  negativeControls: {
    nonRetryable: FixtureResult;
    cancellation: FixtureResult;
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
  authoritativeSource: 'schema-v2 provider-attempt ledger + schema-v3 model request + schema-v3 trace',
  detail,
});

const runFixture = async (mode: FixtureMode): Promise<FixtureResult> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `null-ai-e7-${mode}-`));
  const sessionId = `e7-${mode}`;
  const traceRecorder = new SessionTraceRecorder({
    rootDir: root,
    inlineLimit: 512,
    stdoutChunkSize: 1024,
    compressOverBytes: 1024 * 1024,
    retentionDays: 1,
  });
  await traceRecorder.init(sessionId, {
    workspace: root,
    tools: ['neutral_counter'],
    model: 'scripted-e7',
    agentRole: 'behavior_lab_verifier',
  });
  const session = {
    id: sessionId,
    userId: null,
    flags: { model_selection: { resolvedModelId: 'scripted-e7' } },
    usage: undefined,
  };
  const sessionStore = {
    get: (id: string) => id === sessionId ? session : undefined,
    set: () => undefined,
  };
  const usageStore = new InMemoryUsageStore();
  const usageRecorder = new UsageRecorder(
    sessionStore as never,
    undefined,
    usageStore,
    'scripted-e7',
    undefined,
    undefined,
    traceRecorder,
    root,
  );
  const requestRecords: Array<{ requestId: string }> = [];
  const requestPort = {
    append: async (input: { requestId: string; digest: string }) => {
      requestRecords.push({ requestId: input.requestId });
      return { ...input, provenance: 'recorded' as const, createdAt: new Date() };
    },
    findByRequestId: async () => undefined,
    findBySession: async () => [],
  };
  const controller = new AbortController();
  const request = {
    sessionId,
    messages: [{ role: 'user' as const, content: 'Return one neutral tool call.' }],
    tools: [{
      type: 'function' as const,
      function: {
        name: 'neutral_counter',
        description: 'A deterministic neutral tool.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    }],
    signal: controller.signal,
    maxTokens: 256,
  };
  const canonical = canonicalizeModelRequestEnvelope({
    model: 'scripted-e7',
    messages: request.messages,
    tools: request.tools,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens,
  });
  let providerDispatches = 0;
  const success = {
    message: {
      role: 'assistant' as const,
      content: '',
      tool_calls: [{
        id: 'tool-e7',
        type: 'function' as const,
        function: { name: 'neutral_counter', arguments: '{}' },
      }],
    },
    content: '',
    toolCalls: [{ id: 'tool-e7', function: { name: 'neutral_counter', arguments: '{}' } }],
    totalChars: 0,
    preview: '',
    chunks: [{ type: 'tool_call' as const, name: 'neutral_counter', args: '{}' }, { type: 'done' as const }],
    usage: {
      promptTokens: 1000,
      promptTokensDetails: { cachedTokens: 300, cacheWriteTokens: 200 },
      completionTokens: 100,
      totalTokens: 1100,
    },
    providerRequestId: 'provider-request-e7-2',
    reportedModel: 'scripted-e7',
    reasoningStats: {
      chars: 160,
      estimatedTokens: 40,
      estimated: true,
      source: 'estimated' as const,
    },
  };
  const model = {
    providerName: `scripted-e7-${mode}`,
    getContextCapacity: () => 128_000,
    projectCacheSurface: () => undefined,
    prepare: () => ({
      envelope: canonical.envelope,
      digest: canonical.digest,
      signal: controller.signal,
    }),
    startPrepared: async () => {
      providerDispatches += 1;
      if (mode === 'retry_success' && providerDispatches === 1) {
        throw Object.assign(new Error('transient transport failure'), {
          code: 'network.connection_failed',
          retryable: true,
          retryAfterMs: 0,
          modelAttemptStatus: 'failed' as const,
          modelOutputStarted: false,
        });
      }
      if (mode === 'non_retryable') {
        throw Object.assign(new Error('invalid provider authentication'), {
          code: 'auth.invalid_api_key',
          retryable: false,
          modelAttemptStatus: 'failed' as const,
          modelOutputStarted: false,
        });
      }
      if (mode === 'cancelled_late_result') controller.abort('cancelled-by-behavior-lab');
      return success;
    },
  };
  let executed: Awaited<ReturnType<ModelRuntime['execute']>> | undefined;
  let error: string | undefined;
  try {
    executed = await new ModelRuntime().execute({
      model: model as never,
      usageRecorder,
      request,
      sessionId,
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'scripted-e7',
      maxRetries: 1,
      modelRequestPort: requestPort as never,
      modelRequestCapability: {
        owner: 'behavior-lab.model-requests',
        durability: 'durable',
        schemaVersion: 3,
      },
      routedContextCapacity: 128_000,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await traceRecorder.close(sessionId, {
      terminal: error ? 'error' : 'session.done',
      status: error ? 'failed' : 'completed',
    });
  }

  const requestIds = requestRecords.map((record) => record.requestId);
  const attempts = requestIds[0]
    ? await usageStore.listAttemptsByRequest(requestIds[0])
    : [];
  const tracePath = path.resolve(root, sessionId, 'trace.ndjson');
  const traceLines = (await fs.readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean);
  const traceEvents = traceLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const traceAcceptedHighWater = traceEvents.reduce((highWater, event) => {
    const ordinal = typeof event.acceptedOrdinal === 'number' ? event.acceptedOrdinal : 0;
    return Math.max(highWater, ordinal);
  }, 0);
  const traceAttemptHeaders = traceEvents
    .filter((event) => event.event === 'model.attempt.started' || event.event === 'model.attempt.settled')
    .map((event) => ({
      requestId: typeof event.requestId === 'string' ? event.requestId : undefined,
      attemptId: typeof event.attemptId === 'string' ? event.attemptId : undefined,
      attemptOrdinal: typeof event.attemptOrdinal === 'number' ? event.attemptOrdinal : undefined,
      status: typeof event.status === 'string' ? event.status : undefined,
    }));
  await fs.rm(root, { recursive: true, force: true });
  return {
    mode,
    requestIds,
    attempts,
    providerDispatches,
    toolCalls: (executed?.result.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
    })),
    traceAttemptHeaders,
    traceAcceptedHighWater,
    ...(error ? { error } : {}),
  };
};

const runScenario = async (): Promise<AssembledScenarioResult<ProviderAttemptAccountingEvidenceBundle>> => {
  const correctedFixture = await runFixture('retry_success');
  const nonRetryable = await runFixture('non_retryable');
  const cancellation = await runFixture('cancelled_late_result');
  const requestId = correctedFixture.requestIds[0] ?? 'missing-request';
  const usageTotals = correctedFixture.attempts.reduce((totals, attempt) => ({
    uncachedInput: totals.uncachedInput + attempt.usage.uncachedInput,
    cacheRead: totals.cacheRead + attempt.usage.cacheRead,
    cacheWrite: totals.cacheWrite + attempt.usage.cacheWrite,
    output: totals.output + attempt.usage.output,
    reasoning: totals.reasoning + attempt.usage.reasoning,
  }), { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  const integrity = reconcileTraceIntegrity({
    sessionId: 'e7-retry_success',
    acceptedHighWater: correctedFixture.traceAcceptedHighWater,
    persistedHighWater: correctedFixture.traceAcceptedHighWater,
    terminalReceipt: true,
    expectations: [
      { surface: 'model_requests', id: requestId, present: correctedFixture.requestIds.length === 1 },
      ...buildProviderAttemptIntegrityExpectations([requestId], correctedFixture.attempts),
    ],
  });
  const corrected = { ...correctedFixture, usageTotals, integrity };
  const assertions = [
    assertion(
      'attempts.one_request_two_ordered_attempts',
      corrected.requestIds.length === 1
        && corrected.attempts.length === 2
        && corrected.attempts.every((attempt) => attempt.requestId === requestId)
        && corrected.attempts.map((attempt) => attempt.attemptOrdinal).join(',') === '1,2',
      { requests: 1, attempts: 2, ordinals: [1, 2] },
      { requestIds: corrected.requestIds, ordinals: corrected.attempts.map((attempt) => attempt.attemptOrdinal) },
      'Both provider dispatches must remain children of one immutable E4 request.',
    ),
    assertion(
      'attempts.retry_decision_backoff_and_tool_source',
      corrected.attempts[0]?.state === 'failed'
        && corrected.attempts[0]?.retryDecision === 'retry'
        && corrected.attempts[0]?.backoffMs === 0
        && corrected.attempts[1]?.state === 'succeeded'
        && corrected.toolCalls.length === 1,
      { first: 'failed/retry/0ms', second: 'succeeded', toolCalls: 1 },
      { attempts: corrected.attempts, toolCalls: corrected.toolCalls },
      'A failed attempt cannot contribute response tool calls; only the successful response does.',
    ),
    assertion(
      'usage.cache_and_reasoning_are_exact',
      JSON.stringify(usageTotals) === JSON.stringify({
        uncachedInput: 500,
        cacheRead: 300,
        cacheWrite: 200,
        output: 100,
        reasoning: 40,
      })
        && corrected.attempts[1]?.usage.reasoningSource === 'estimated',
      { uncachedInput: 500, cacheRead: 300, cacheWrite: 200, output: 100, reasoning: 40 },
      usageTotals,
      'Cache reads and writes are distinct components, and reasoning names its source.',
    ),
    assertion(
      'trace.headers_and_e6_integrity_are_complete',
      corrected.traceAttemptHeaders.length === 4
        && corrected.traceAttemptHeaders.every((header) =>
          header.requestId === requestId && Boolean(header.attemptId) && Boolean(header.attemptOrdinal))
        && integrity.status === 'complete'
        && integrity.surfaces.provider_attempts === 'complete',
      { traceAttemptHeaders: 4, integrity: 'complete' },
      { traceAttemptHeaders: corrected.traceAttemptHeaders, integrity },
      'Attempt trace projections retain request/attempt identity and reconcile from the ledger.',
    ),
    assertion(
      'negative.non_retryable_stops_once',
      nonRetryable.providerDispatches === 1
        && nonRetryable.attempts.length === 1
        && nonRetryable.attempts[0]?.state === 'failed'
        && nonRetryable.attempts[0]?.retryDecision === 'stop',
      { dispatches: 1, attempts: 1, decision: 'stop' },
      nonRetryable,
      'A normalized non-retryable error must not enter the retry loop.',
    ),
    assertion(
      'negative.cancellation_blocks_late_success',
      cancellation.providerDispatches === 1
        && cancellation.attempts.length === 1
        && cancellation.attempts[0]?.state === 'cancelled'
        && cancellation.toolCalls.length === 0
        && Boolean(cancellation.error),
      { attempts: 1, state: 'cancelled', toolCalls: 0 },
      cancellation,
      'A result arriving after cancellation cannot overwrite the terminal attempt state.',
    ),
  ];
  const evidence: ProviderAttemptAccountingEvidenceBundle = {
    schema: 'behavior-lab-provider-attempt-accounting-evidence/v1',
    scenarioId: E7_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    corrected,
    negativeControls: { nonRetryable, cancellation },
    assertions,
    verdict: {
      correctedFixturePassed: assertions.slice(0, 4).every((entry) => entry.passed),
      negativeControlDetected: assertions.slice(4).every((entry) => entry.passed),
      namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
    },
  };
  const passed = assertions.every((entry) => entry.passed);
  return {
    id: E7_ASSEMBLED_SCENARIO_ID,
    title: 'Harness provider retry keeps one logical request',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? { error: `failed=${evidence.verdict.namedMismatches.join(',')}` } : {}),
  };
};

export const providerAttemptAccountingEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-provider-attempt-accounting-evidence/v1'),
  scenarioId: z.literal(E7_ASSEMBLED_SCENARIO_ID),
  corrected: z.object({
    requestIds: z.array(z.string()).length(1),
    attempts: z.array(z.object({
      requestId: z.string(),
      attemptId: z.string(),
      attemptOrdinal: z.number().int().positive(),
      state: z.enum(['started', 'succeeded', 'failed', 'cancelled']),
      usage: z.object({ reasoningSource: z.enum(['reported', 'estimated', 'unavailable']) }).passthrough(),
    }).passthrough()).length(2),
    integrity: z.object({ status: z.literal('complete') }).passthrough(),
  }).passthrough(),
  negativeControls: z.object({
    nonRetryable: z.object({ providerDispatches: z.literal(1) }).passthrough(),
    cancellation: z.object({ providerDispatches: z.literal(1) }).passthrough(),
  }),
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string()),
  }),
}).passthrough();

export const providerAttemptAccountingScenario:
AssembledBehaviorScenario<ProviderAttemptAccountingEvidenceBundle> = {
  id: E7_ASSEMBLED_SCENARIO_ID,
  title: 'Harness provider retry keeps one logical request',
  why: 'Runs the production ModelRuntime retry seam and durable attempt accounting with cache, reasoning, trace, non-retryable, and cancellation controls.',
  run: runScenario,
};
