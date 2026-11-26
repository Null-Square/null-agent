/**
 * Shipping composition — the evidence chain, assembled the way production assembles it.
 *
 * This is the structural lesson of the r1 audit. The remaining harness failures were at the
 * **seams**, not in the components, and every component test passed while the shipping graph
 * violated the contract those tests assert:
 *
 * - `UsageRecorder` had correct telemetry code and `TurnRunner` passed `undefined` for its
 *   recorder, so `model.attempt.*` and `usage.recorded` never reached a trace (D6).
 * - `SessionTraceRecorder` closed correctly and swallowed the failure of the row that makes
 *   the close discoverable, so every run read as degraded (D5).
 * - `usage.recorded` carried `promptTokens` meaning total input while the summary of the
 *   same name meant uncached input (D7).
 *
 * So this scenario builds `UsageRecorder` **exactly as `TurnRunner` builds it** — including
 * the `undefined` in the constructor — and relies solely on the production path that hands
 * the recorder to the attempt. If that path is ever unwired again, the chain breaks here.
 *
 * The negative control reproduces the production defect on purpose, so a pass can never be
 * an absence of evidence.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { ModelRuntime } from '../../../../src/domains/agent-brain/application/orchestration/ModelRuntime';
import { canonicalizeModelRequestEnvelope } from '../../../../src/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import { projectOpenAiCompatibleCacheSurface } from '../../../../src/domains/agent-brain/domain/cache';
import { SessionTraceRecorder } from '../../../../src/domains/agent-brain/infrastructure/telemetry/SessionTraceRecorder';
import { UsageRecorder } from '../../../../src/domains/agent-brain/infrastructure/usage/UsageRecorder';
import { InMemoryUsageStore } from '../../../../src/domains/platform/subscriptions/infrastructure/usageStores';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const SHIPPING_COMPOSITION_SCENARIO_ID =
  'harness-shipping-composition-joins-the-evidence-chain';

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  detail: string,
  authoritativeSource = 'the production dependency graph, assembled as TurnRunner assembles it',
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

type TraceIndexBehaviour = 'persists' | 'always_fails';

type CompositionRun = {
  traceEvents: Array<Record<string, unknown>>;
  eventNames: string[];
  durableAttempts: number;
  integrityStatus: string;
  indexRowWritten: boolean;
  usagePayload: Record<string, unknown> | undefined;
};

const runComposition = async (input: {
  sessionId: string;
  /** When false, the trace recorder never reaches the attempt — the r1 defect. */
  wireTraceRecorder: boolean;
  traceIndex: TraceIndexBehaviour;
}): Promise<CompositionRun> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'behavior-composition-'));
  const { sessionId } = input;

  const rows = new Map<string, unknown>();
  const traceIndexRepo = {
    upsert: async (entry: { sessionId: string }) => {
      if (input.traceIndex === 'always_fails') {
        throw new Error('relation "trace_index" does not exist');
      }
      rows.set(entry.sessionId, entry);
    },
    find: async (id: string) => rows.get(id) ?? null,
  };

  const traceRecorder = new SessionTraceRecorder(
    { rootDir: root, inlineLimit: 4096, stdoutChunkSize: 1024, compressOverBytes: 1024 * 1024 },
    undefined,
    traceIndexRepo as never,
  );
  await traceRecorder.init(sessionId, {
    workspace: root,
    tools: ['neutral_counter'],
    model: 'scripted-composition',
    agentRole: 'behavior_lab_verifier',
  });

  const session = {
    id: sessionId,
    userId: null,
    flags: { model_selection: { resolvedModelId: 'scripted-composition' } },
    usage: undefined,
  };
  const sessionStore = {
    get: (id: string) => (id === sessionId ? session : undefined),
    set: () => undefined,
  };
  const usageStore = new InMemoryUsageStore();

  // Exactly the shape TurnRunner builds, `undefined` and all. Nothing here may compensate
  // for a broken production wiring, or the scenario stops measuring production.
  const usageRecorder = new UsageRecorder(
    sessionStore as never,
    undefined,
    usageStore,
    'scripted-composition',
    undefined,
    undefined,
    undefined,
    root,
  );

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
    model: 'scripted-composition',
    messages: request.messages,
    tools: request.tools,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens,
  });

  const requestRecords: Array<{ requestId: string }> = [];
  const requestPort = {
    append: async (appended: { requestId: string; digest: string }) => {
      requestRecords.push({ requestId: appended.requestId });
      return { ...appended, provenance: 'recorded' as const, createdAt: new Date() };
    },
    findByRequestId: async () => undefined,
    findBySession: async () => [],
  };

  const model = {
    providerName: 'scripted-composition',
    getContextCapacity: () => 128_000,
    // D8 - a model with a cache surface, so the lineage the observer produces has somewhere
    // to come from. Uses the shipping projection, not a stand-in for it.
    projectCacheSurface: (
      envelope: Record<string, unknown>,
      identity: Parameters<typeof projectOpenAiCompatibleCacheSurface>[0]['identity'],
    ) => projectOpenAiCompatibleCacheSurface({ envelope, identity }),
    prepare: () => ({
      envelope: canonical.envelope,
      digest: canonical.digest,
      signal: controller.signal,
    }),
    startPrepared: async () => ({
      message: {
        role: 'assistant' as const,
        content: '',
        tool_calls: [{
          id: 'tool-composition',
          type: 'function' as const,
          function: { name: 'neutral_counter', arguments: '{}' },
        }],
      },
      content: '',
      toolCalls: [{ id: 'tool-composition', function: { name: 'neutral_counter', arguments: '{}' } }],
      totalChars: 0,
      preview: '',
      chunks: [{ type: 'tool_call' as const, name: 'neutral_counter', args: '{}' }, { type: 'done' as const }],
      usage: {
        promptTokens: 1_000,
        promptTokensDetails: { cachedTokens: 300, cacheWriteTokens: 200 },
        completionTokens: 100,
        totalTokens: 1_100,
      },
      providerRequestId: 'provider-request-composition',
      reportedModel: 'scripted-composition',
      reasoningStats: { chars: 160, estimatedTokens: 40, estimated: true, source: 'estimated' as const },
    }),
  };

  let failure: string | undefined;
  try {
    await new ModelRuntime().execute({
      model: model as never,
      usageRecorder,
      // The production path. TurnStreamController supplies the per-turn recorder here.
      ...(input.wireTraceRecorder ? { traceRecorder } : {}),
      request,
      sessionId,
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'scripted-composition',
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
    failure = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await traceRecorder.close(sessionId, {
      terminal: failure ? 'error' : 'session.done',
      status: failure ? 'failed' : 'completed',
    });
  }

  const tracePath = path.resolve(root, sessionId, 'trace.ndjson');
  const traceEvents = (await fs.readFile(tracePath, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const indexPath = path.join(root, 'index.json');
  const rawIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as unknown;
  const entries = Array.isArray(rawIndex) ? rawIndex : Object.values(rawIndex as object);
  const indexEntry = (entries as Array<Record<string, unknown>>)
    .find((entry) => entry?.sessionId === sessionId);

  const requestId = requestRecords[0]?.requestId;
  const durableAttempts = requestId ? (await usageStore.listAttemptsByRequest(requestId)).length : 0;

  const usageEvent = traceEvents.find((event) => event.event === 'usage.recorded');

  await fs.rm(root, { recursive: true, force: true });

  return {
    traceEvents,
    eventNames: [...new Set(traceEvents.map((event) => String(event.event)))],
    durableAttempts,
    integrityStatus: String(indexEntry?.integrityStatus ?? 'unknown'),
    indexRowWritten: rows.has(sessionId),
    usagePayload: (usageEvent?.payload ?? undefined) as Record<string, unknown> | undefined,
  };
};

/**
 * The chain a closed session must be able to show, end to end.
 *
 * D8 added the two lineage events: the observer's logic was sound and its output went to
 * `log.debug` and an in-memory map, so all five session traces from run r1 contained zero
 * lineage events and no production question about the cache could be answered.
 */
const REQUIRED_CHAIN = [
  'model.attempt.started',
  'model.attempt.settled',
  'usage.recorded',
  'cache.lineage_expectation',
  'cache.lineage_observed',
] as const;

const shippingCompositionEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-assembled-evidence/v1'),
  scenario: z.literal(SHIPPING_COMPOSITION_SCENARIO_ID),
  wired: z.object({
    eventNames: z.array(z.string()),
    missingFromChain: z.array(z.string()),
    durableAttempts: z.number(),
    integrityStatus: z.string(),
    indexRowWritten: z.boolean(),
    usageVocabulary: z.array(z.string()),
  }),
  unwired: z.object({
    missingFromChain: z.array(z.string()),
    durableAttempts: z.number(),
  }),
  brokenIndex: z.object({
    integrityStatus: z.string(),
    indexRowWritten: z.boolean(),
  }),
  assertions: z.array(z.object({
    id: z.string(),
    passed: z.boolean(),
    expected: z.unknown(),
    actual: z.unknown(),
    authoritativeSource: z.string(),
    detail: z.string(),
  })),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string()),
  }),
});

export type ShippingCompositionEvidence = z.infer<typeof shippingCompositionEvidenceSchema>;

const missingFrom = (eventNames: string[]): string[] =>
  REQUIRED_CHAIN.filter((name) => !eventNames.includes(name));

const run = async (): Promise<AssembledScenarioResult<ShippingCompositionEvidence>> => {
  const wired = await runComposition({
    sessionId: 'composition-wired',
    wireTraceRecorder: true,
    traceIndex: 'persists',
  });
  const unwired = await runComposition({
    sessionId: 'composition-unwired',
    wireTraceRecorder: false,
    traceIndex: 'persists',
  });
  const brokenIndex = await runComposition({
    sessionId: 'composition-broken-index',
    wireTraceRecorder: true,
    traceIndex: 'always_fails',
  });

  const wiredMissing = missingFrom(wired.eventNames);
  const unwiredMissing = missingFrom(unwired.eventNames);
  const usageVocabulary = Object.keys(wired.usagePayload ?? {}).sort();

  const assertions: VerificationAssertion[] = [
    assertion(
      'composition.provider_attempt_events_reach_the_trace',
      wiredMissing.length === 0,
      { missing: [] },
      { missing: wiredMissing, eventNames: wired.eventNames },
      'Run r1 wrote 140 durable usage rows and zero attempt or usage trace events, because '
        + 'TurnRunner passed undefined for the recorder and nothing noticed.',
    ),
    assertion(
      'composition.durable_and_trace_records_agree',
      wired.durableAttempts === 1 && wiredMissing.length === 0,
      { durableAttempts: 1, traceChainComplete: true },
      { durableAttempts: wired.durableAttempts, missing: wiredMissing },
      'A durable row with no trace event is exactly the shape that hid the defect: both '
        + 'halves must exist, or the run cannot be reconstructed.',
    ),
    assertion(
      'composition.negative_control_an_unwired_recorder_breaks_the_chain',
      unwiredMissing.length === REQUIRED_CHAIN.length && unwired.durableAttempts === 1,
      { missing: [...REQUIRED_CHAIN], durableAttempts: 1 },
      { missing: unwiredMissing, durableAttempts: unwired.durableAttempts },
      'Reproduces the production defect deliberately. Durable accounting still works, which '
        + 'is why it went unnoticed for the life of the feature.',
    ),
    assertion(
      'composition.usage_vocabulary_is_unambiguous',
      usageVocabulary.includes('inputTokensTotal')
        && usageVocabulary.includes('uncachedInputTokens')
        && usageVocabulary.includes('cacheReadTokens')
        && usageVocabulary.includes('cacheWriteTokens')
        && !usageVocabulary.includes('promptTokens'),
      {
        includes: ['inputTokensTotal', 'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
        excludes: ['promptTokens'],
      },
      { usageVocabulary },
      'promptTokens meant total input here and uncached input on the summary of the same '
        + 'name, which is how the admin timeline printed a 1,117% cache rate.',
    ),
    assertion(
      'composition.a_close_with_a_readable_receipt_is_complete',
      wired.integrityStatus === 'complete' && wired.indexRowWritten,
      { integrityStatus: 'complete', indexRowWritten: true },
      { integrityStatus: wired.integrityStatus, indexRowWritten: wired.indexRowWritten },
      'The terminal index receipt is what makes a closed trace discoverable.',
    ),
    assertion(
      'composition.negative_control_an_unwritable_receipt_is_not_complete',
      brokenIndex.integrityStatus !== 'complete' && brokenIndex.indexRowWritten === false,
      { integrityStatus: 'not complete', indexRowWritten: false },
      {
        integrityStatus: brokenIndex.integrityStatus,
        indexRowWritten: brokenIndex.indexRowWritten,
      },
      'The index write used to be caught, logged as a warning and reported as success. The '
        + 'trace_index table held zero rows globally and every run still claimed to close.',
    ),
  ];

  const namedMismatches = assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
  const negativeControlDetected = unwiredMissing.length === REQUIRED_CHAIN.length
    && brokenIndex.integrityStatus !== 'complete';

  const evidence = {
    schema: 'behavior-lab-assembled-evidence/v1',
    scenario: SHIPPING_COMPOSITION_SCENARIO_ID,
    wired: {
      eventNames: wired.eventNames,
      missingFromChain: wiredMissing,
      durableAttempts: wired.durableAttempts,
      integrityStatus: wired.integrityStatus,
      indexRowWritten: wired.indexRowWritten,
      usageVocabulary,
    },
    unwired: {
      missingFromChain: unwiredMissing,
      durableAttempts: unwired.durableAttempts,
    },
    brokenIndex: {
      integrityStatus: brokenIndex.integrityStatus,
      indexRowWritten: brokenIndex.indexRowWritten,
    },
    assertions,
    verdict: {
      correctedFixturePassed: namedMismatches.length === 0,
      negativeControlDetected,
      namedMismatches,
    },
  } as const;

  const parsed = shippingCompositionEvidenceSchema.safeParse(evidence);
  const passed = namedMismatches.length === 0 && negativeControlDetected && parsed.success;

  return {
    id: SHIPPING_COMPOSITION_SCENARIO_ID,
    title: 'The shipping dependency graph joins request, attempt, usage and terminal receipt',
    mode: 'assembled-runtime',
    passed,
    evidence: evidence as unknown as ShippingCompositionEvidence,
    ...(parsed.success ? {} : { error: parsed.error.message }),
  };
};

export const shippingCompositionScenario:
AssembledBehaviorScenario<ShippingCompositionEvidence> = {
  id: SHIPPING_COMPOSITION_SCENARIO_ID,
  title: 'The shipping dependency graph joins request, attempt, usage and terminal receipt',
  why:
    'Every remaining harness failure in run r1 was at a seam. Each component was internally '
    + 'correct and its own tests passed, while the production composition violated the '
    + 'contract those tests assert. This scenario builds the graph the way production builds '
    + 'it and asserts the evidence chain survives a close.',
  run,
};
