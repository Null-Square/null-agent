import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { ModelRuntime } from '../../../../src/domains/agent-brain/application/orchestration/ModelRuntime';
import { ModelStream } from '../../../../src/domains/agent-brain/application/orchestration/streaming/ModelStream';
import {
  canonicalizeModelRequestEnvelope,
} from '../../../../src/domains/agent-brain/domain/modelRequests/canonicalModelRequest';
import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  type RuntimeHostCapabilities,
} from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import type {
  AppendModelRequestInput,
  ModelRequestPort,
  ModelRequestRecord,
} from '../../../../src/domains/agent-brain/ports';
import {
  getHostedRunModelRequestLifecycle,
  registerHostedRunPersistencePort,
} from '../../../../src/domains/security-ops/runs/HostedRunPersistencePort';
import { InMemoryUsageStore } from '../../../../src/domains/platform/subscriptions/infrastructure/usageStores';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E4_ASSEMBLED_SCENARIO_ID =
  'harness-recorded-request-equals-provider-dispatch';

type HostKind = 'organization' | 'research_lab';
type SerializedRequest = Omit<ModelRequestRecord, 'createdAt'> & { createdAt: string };

type AttemptEvidence = {
  attemptId: string;
  requestId?: string | null;
  ordinal: number;
};

type HostFixtureEvidence = {
  hostKind: HostKind;
  capabilities: RuntimeHostCapabilities;
  selectedOwner: string;
  registeredHostedPort: boolean;
  coldRestartPerformed: true;
  eventOrder: string[];
  persistedRequest: SerializedRequest;
  dispatchedEnvelopes: Record<string, unknown>[];
  attempts: AttemptEvidence[];
  result: string;
  assertions: VerificationAssertion[];
  passed: boolean;
};

type NegativeFixtureEvidence = {
  persistedDigest: string;
  mutatedDigest: string;
  transportDispatches: number;
  errorCode?: string;
  assertions: VerificationAssertion[];
  passed: boolean;
};

export type AtomicModelRequestEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-atomic-model-request-evidence/v1';
  scenarioId: typeof E4_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  claim: {
    ordering: 'assemble -> canonicalize -> append request record -> provider attempt -> dispatch';
    terminalPredicates: string[];
  };
  fixtures: {
    organization: HostFixtureEvidence;
    researchLab: HostFixtureEvidence;
    negativeControl: NegativeFixtureEvidence;
  };
};

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  authoritativeSource: string,
  detail: string,
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

const clone = <T>(value: T): T => structuredClone(value);

class FileModelRequestLedger implements ModelRequestPort {
  constructor(
    private readonly filePath: string,
    private readonly eventOrder: string[],
  ) {}

  async append(input: AppendModelRequestInput): Promise<ModelRequestRecord> {
    const records = this.read();
    const existing = records.find((record) => record.requestId === input.requestId);
    if (existing) {
      if (existing.digest !== input.digest) throw new Error('model_request_immutable_conflict');
      return this.deserialize(existing);
    }
    const record: SerializedRequest = {
      ...clone(input),
      provenance: 'recorded',
      createdAt: (input.createdAt ?? new Date()).toISOString(),
    };
    records.push(record);
    this.write(records);
    this.eventOrder.push('request.persisted');
    return this.deserialize(record);
  }

  async findByRequestId(requestId: string): Promise<ModelRequestRecord | undefined> {
    const record = this.read().find((candidate) => candidate.requestId === requestId);
    return record ? this.deserialize(record) : undefined;
  }

  async findBySession(sessionId: string): Promise<ModelRequestRecord[]> {
    return this.read()
      .filter((record) => record.sessionId === sessionId)
      .map((record) => this.deserialize(record));
  }

  private read(): SerializedRequest[] {
    if (!existsSync(this.filePath)) return [];
    return (JSON.parse(readFileSync(this.filePath, 'utf8')) as { records: SerializedRequest[] }).records;
  }

  private write(records: SerializedRequest[]): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 2, records }, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.filePath);
  }

  private deserialize(record: SerializedRequest): ModelRequestRecord {
    return { ...clone(record), createdAt: new Date(record.createdAt) };
  }
}

const serialize = (record: ModelRequestRecord): SerializedRequest => ({
  ...clone(record),
  createdAt: record.createdAt.toISOString(),
});

const unusedToolLifecycle = () => ({
  claim: async () => { throw new Error('unused E4 tool lifecycle'); },
  markStarted: async () => undefined,
  block: async () => undefined,
  markOutcomeUnknown: async () => undefined,
});

const unusedHistoryTransformationLifecycle = () => ({
  prepare: async () => { throw new Error('unused E4 history transformation lifecycle'); },
  persistReplacement: async () => { throw new Error('unused E4 history transformation lifecycle'); },
  activate: async () => { throw new Error('unused E4 history transformation lifecycle'); },
  findById: async () => undefined,
  findActiveBySession: async () => undefined,
  findBySession: async () => [],
});

const createProvider = (input: {
  eventOrder: string[];
  dispatched: Record<string, unknown>[];
  partialMarker: string;
}) => {
  let dispatchOrdinal = 0;
  const create = async (body: Record<string, unknown>) => {
    dispatchOrdinal += 1;
    input.eventOrder.push(`provider.dispatch.${dispatchOrdinal}`);
    input.dispatched.push(clone(body));
    if (dispatchOrdinal === 1) {
      throw Object.assign(new Error('deterministic transport failure'), {
        retryable: true,
        retryAfterMs: 0,
        modelAttemptStatus: 'failed' as const,
        modelOutputStarted: false,
        partialOutput: input.partialMarker,
      });
    }
    return (async function* deterministicStream() {
      yield {
        id: 'provider-response-2',
        model: 'behavior-model-v2',
        choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
      };
      yield {
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
        choices: [],
      };
    })();
  };
  return {
    name: 'behavior-deterministic-provider',
    getCapabilities: () => ({
      explicitCacheControl: false,
      automaticCaching: true,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      toolCalling: true,
      streaming: true,
      rateLimitHeaders: false,
    }),
    getClient: () => ({ chat: { completions: { create } } }),
    buildSystemMessages: () => [],
    decorateRequest: (body: Record<string, unknown>) => ({
      ...body,
      top_p: 0.9,
      tool_choice: 'auto',
    }),
    normalizeUsage: (usage: Record<string, number>) => ({
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    }),
    mapError: (error: unknown) => error,
    supportsCacheControl: () => false,
  };
};

const capabilityFactory = (hostKind: HostKind) => hostKind === 'organization'
  ? createOrganizationRuntimeHostCapabilities()
  : createResearchLabRuntimeHostCapabilities();

const runHostFixture = async (hostKind: HostKind): Promise<HostFixtureEvidence> => {
  const root = mkdtempSync(path.join(os.tmpdir(), `null-ai-behavior-e4-${hostKind}-`));
  const ledgerPath = path.resolve(root, 'model-requests.json');
  const eventOrder: string[] = [];
  const ledger = new FileModelRequestLedger(ledgerPath, eventOrder);
  const capabilities = capabilityFactory(hostKind);
  const runId = `behavior-e4-${hostKind}`;
  const dispatched: Record<string, unknown>[] = [];
  const attempts: AttemptEvidence[] = [];
  const partialMarker = 'UNPERSISTED_PARTIAL_OUTPUT';
  let unregister: (() => void) | undefined;

  try {
    let selectedLedger: ModelRequestPort = ledger;
    if (hostKind === 'research_lab') {
      unregister = registerHostedRunPersistencePort({
        kind: 'research_lab',
        runId,
        runtimeHostCapabilities: capabilities,
        toolExecutionLifecycle: unusedToolLifecycle(),
        modelRequestLifecycle: ledger,
        providerAttemptLifecycle: new InMemoryUsageStore(),
        historyTransformationLifecycle: unusedHistoryTransformationLifecycle(),
      } as any);
      selectedLedger = getHostedRunModelRequestLifecycle({
        runId,
        runHost: 'research_lab',
      }) ?? ledger;
    }

    const provider = createProvider({ eventOrder, dispatched, partialMarker });
    const model = new ModelStream({ provider: provider as any });
    model.setModelName('behavior-model-v2');
    const usageRecorder = {
      beginAttempt: async (_sessionId: string, attempt: {
        attemptOrdinal: number;
        modelRequestId?: string | null;
      }) => {
        const attemptId = `${hostKind}-attempt-${attempt.attemptOrdinal}`;
        eventOrder.push(`attempt.persisted.${attempt.attemptOrdinal}`);
        attempts.push({
          attemptId,
          requestId: attempt.modelRequestId,
          ordinal: attempt.attemptOrdinal,
        });
        return { id: attemptId };
      },
      failAttempt: async () => undefined,
      recordUsage: async () => ({
        promptTokens: 20,
        cachedPromptTokens: 0,
        completionTokens: 2,
        totalTokens: 22,
        nativeCost: 0,
        overhead: 0,
        platformCost: 0,
        platformPrice: 0,
        credits: 0,
        currency: 'usd',
        model: 'behavior-model-v2',
      }),
    };
    const request = {
      sessionId: `${hostKind}-session`,
      agentType: 'planner',
      missionPhaseKey: 'planning',
      messages: [
        { role: 'system' as const, content: 'Follow the transformed system contract.' },
        { role: 'user' as const, content: 'Inspect the neutral target.' },
      ],
      tools: [{
        type: 'function' as const,
        function: {
          name: 'neutral_inspect',
          description: 'Inspect a neutral target.',
          parameters: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target'],
          },
        },
      }],
      signal: new AbortController().signal,
      maxTokens: 256,
      temperature: 0.2,
    };
    const executed = await new ModelRuntime().execute({
      model,
      usageRecorder: usageRecorder as any,
      request,
      sessionId: request.sessionId,
      runId,
      stepId: 'step-1',
      turn: 1,
      callOrdinal: 1,
      configuredModelName: 'behavior-model-v2',
      modelRequestPort: selectedLedger,
      modelRequestCapability: capabilities.modelRequests,
      maxRetries: 1,
      contextMeasurementRefs: ['context-budget:fixture-1'],
      transformationRefs: ['history:transformed', 'tools:resolved'],
    });
    const coldLedger = new FileModelRequestLedger(ledgerPath, []);
    const coldRecord = await coldLedger.findByRequestId(executed.requestId ?? 'missing');
    if (!coldRecord) throw new Error('E4 fixture request did not survive cold reconstruction');
    const persistIndex = eventOrder.indexOf('request.persisted');
    const firstAttemptIndex = eventOrder.indexOf('attempt.persisted.1');
    const firstDispatchIndex = eventOrder.indexOf('provider.dispatch.1');
    const canonicalDispatched = dispatched.map((envelope) =>
      canonicalizeModelRequestEnvelope(envelope).digest);
    const requestIds = attempts.map((attempt) => attempt.requestId);
    const attemptIds = attempts.map((attempt) => attempt.attemptId);
    const assertions = [
      assertion(
        'request.persisted_before_every_attempt_and_dispatch',
        persistIndex >= 0 && persistIndex < firstAttemptIndex && firstAttemptIndex < firstDispatchIndex,
        'request.persisted < attempt.persisted.1 < provider.dispatch.1',
        eventOrder,
        'model-requests.json + attempt and transport event order',
        'The exact logical request must be durable before either provider attempt begins.',
      ),
      assertion(
        'request.persisted_once_across_retry',
        eventOrder.filter((event) => event === 'request.persisted').length === 1,
        1,
        eventOrder.filter((event) => event === 'request.persisted').length,
        'model-requests.json',
        'A retry reuses one logical request instead of appending a different request.',
      ),
      assertion(
        'dispatch.canonical_content_equals_record',
        dispatched.length === 2
          && canonicalDispatched.every((digest) => digest === coldRecord.digest)
          && JSON.stringify(dispatched[1]) === JSON.stringify(coldRecord.envelope),
        { digest: coldRecord.digest, envelope: coldRecord.envelope },
        { digests: canonicalDispatched, envelope: dispatched[1] },
        'model-requests.json#/records/0 + deterministic transport capture',
        'The provider-visible envelope for every attempt must equal the immutable record.',
      ),
      assertion(
        'attempts.share_request_and_have_distinct_ids',
        attempts.length === 2
          && requestIds.every((requestId) => requestId === coldRecord.requestId)
          && new Set(attemptIds).size === 2,
        { requestId: coldRecord.requestId, distinctAttempts: 2 },
        { requestIds, attemptIds },
        'provider attempt fixture ledger',
        'Attempts are children of one logical request but keep separate attempt identities.',
      ),
      assertion(
        'history.failed_partial_output_not_canonical',
        !JSON.stringify(coldRecord.messages).includes(partialMarker)
          && !JSON.stringify(coldRecord.envelope).includes(partialMarker),
        'partial marker absent',
        coldRecord.messages,
        'model-requests.json#/records/0/messages',
        'Transport failure details and partial output cannot enter canonical model history.',
      ),
      assertion(
        'request.captures_system_tools_routing_and_settings',
        coldRecord.systemContent.length === 1
          && coldRecord.tools.length === 1
          && coldRecord.provider === provider.name
          && coldRecord.model === 'behavior-model-v2'
          && coldRecord.generationSettings.temperature === 0.2
          && coldRecord.generationSettings.top_p === 0.9
          && coldRecord.toolChoice === 'auto'
          && coldRecord.routedContextCapacity === 128000
          && coldRecord.contextMeasurement?.requestId === coldRecord.requestId
          && coldRecord.contextMeasurement?.routedCapacity === 128000,
        'complete effective request metadata',
        coldRecord,
        'model-requests.json#/records/0',
        'The immutable record includes every model-visible component and routed capacity.',
      ),
    ];

    return {
      hostKind,
      capabilities,
      selectedOwner: capabilities.modelRequests.owner,
      registeredHostedPort: hostKind === 'research_lab',
      coldRestartPerformed: true,
      eventOrder,
      persistedRequest: serialize(coldRecord),
      dispatchedEnvelopes: dispatched,
      attempts,
      result: executed.result.content,
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    unregister?.();
    rmSync(root, { recursive: true, force: true });
  }
};

const runNegativeControl = async (): Promise<NegativeFixtureEvidence> => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'null-ai-behavior-e4-negative-'));
  const eventOrder: string[] = [];
  const ledger = new FileModelRequestLedger(path.resolve(root, 'model-requests.json'), eventOrder);
  let transportDispatches = 0;
  let errorCode: string | undefined;

  try {
    const provider = createProvider({
      eventOrder,
      dispatched: [],
      partialMarker: 'not-used',
    });
    const originalClient = provider.getClient();
    provider.getClient = () => ({
      chat: {
        completions: {
          create: async (...args: unknown[]) => {
            transportDispatches += 1;
            return originalClient.chat.completions.create(...args as [Record<string, unknown>]);
          },
        },
      },
    });
    const model = new ModelStream({ provider: provider as any });
    model.setModelName('behavior-model-v2');
    const prepared = model.prepare({
      sessionId: 'negative-session',
      messages: [{ role: 'user', content: 'Inspect the neutral target.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'neutral_inspect',
          description: 'Inspect a neutral target.',
          parameters: { type: 'object', properties: { target: { type: 'string' } } },
        },
      }],
      signal: new AbortController().signal,
    });
    const requestId = '44444444-4444-4444-8444-444444444444';
    const messages = prepared.envelope.messages as any[];
    const tools = prepared.envelope.tools as any[];
    await ledger.append({
      requestId,
      schemaVersion: 2,
      sessionId: 'negative-session',
      turn: 1,
      callOrdinal: 1,
      routeReason: 'session_pinned',
      provider: provider.name,
      model: 'behavior-model-v2',
      routedContextCapacity: 128000,
      messages,
      systemContent: [],
      tools,
      toolChoice: prepared.envelope.tool_choice,
      generationSettings: {},
      contextMeasurementRefs: [],
      transformationRefs: [],
      envelope: clone(prepared.envelope),
      digest: prepared.digest,
    });
    (prepared.envelope.tools as any[])[0].function.parameters = {
      type: 'object',
      additionalProperties: true,
    };
    const mutatedDigest = canonicalizeModelRequestEnvelope(prepared.envelope).digest;
    try {
      await model.startPrepared(prepared);
    } catch (error) {
      errorCode = (error as { code?: string }).code;
    }
    const assertions = [
      assertion(
        'dispatch.digest_matches_record',
        prepared.digest === mutatedDigest,
        prepared.digest,
        mutatedDigest,
        'model-requests.json + canonical dispatch digest',
        'A tool-schema mutation after persistence must violate the request digest invariant.',
      ),
      assertion(
        'dispatch.mutation_blocked_before_transport',
        errorCode === 'model_request_digest_mismatch' && transportDispatches === 0,
        { errorCode: 'model_request_digest_mismatch', transportDispatches: 0 },
        { errorCode, transportDispatches },
        'ModelStream.startPrepared digest guard + transport counter',
        'The mismatch must fail before the provider transport can observe the mutated envelope.',
      ),
    ];
    return {
      persistedDigest: prepared.digest,
      mutatedDigest,
      transportDispatches,
      errorCode,
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const assertionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown(),
  actual: z.unknown(),
  authoritativeSource: z.string().min(1),
  detail: z.string().min(1),
});

const hostFixtureSchema = z.object({
  hostKind: z.enum(['organization', 'research_lab']),
  capabilities: z.object({
    hostKind: z.enum(['organization', 'research_lab']),
    modelRequests: z.object({
      owner: z.string().min(1),
      durability: z.literal('durable'),
      schemaVersion: z.literal(3),
    }),
  }).passthrough(),
  selectedOwner: z.string().min(1),
  registeredHostedPort: z.boolean(),
  coldRestartPerformed: z.literal(true),
  eventOrder: z.array(z.string().min(1)),
  persistedRequest: z.object({
    requestId: z.string().min(1),
    schemaVersion: z.literal(3),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    createdAt: z.string().datetime(),
    envelope: z.record(z.unknown()),
  }).passthrough(),
  dispatchedEnvelopes: z.array(z.record(z.unknown())).length(2),
  attempts: z.array(z.object({
    attemptId: z.string().min(1),
    requestId: z.string().min(1).nullable().optional(),
    ordinal: z.number().int().positive(),
  })).length(2),
  result: z.literal('done'),
  assertions: z.array(assertionSchema).min(1),
  passed: z.literal(true),
});

export const atomicModelRequestEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-atomic-model-request-evidence/v1'),
  scenarioId: z.literal(E4_ASSEMBLED_SCENARIO_ID),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  claim: z.object({
    ordering: z.literal('assemble -> canonicalize -> append request record -> provider attempt -> dispatch'),
    terminalPredicates: z.array(z.string().min(1)).min(1),
  }),
  fixtures: z.object({
    organization: hostFixtureSchema,
    researchLab: hostFixtureSchema,
    negativeControl: z.object({
      persistedDigest: z.string().min(1),
      mutatedDigest: z.string().min(1),
      transportDispatches: z.literal(0),
      errorCode: z.literal('model_request_digest_mismatch'),
      assertions: z.array(assertionSchema).min(1),
      passed: z.literal(false),
    }),
  }),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string().min(1)),
  }),
});

const resolveCommit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
};

const run = async (): Promise<AssembledScenarioResult<AtomicModelRequestEvidenceBundle>> => {
  const organization = await runHostFixture('organization');
  const researchLab = await runHostFixture('research_lab');
  const negativeControl = await runNegativeControl();
  const correctedFixturePassed = organization.passed && researchLab.passed;
  const namedMismatches = negativeControl.assertions
    .filter((entry) => !entry.passed)
    .map((entry) => entry.id);
  const negativeControlDetected = !negativeControl.passed
    && namedMismatches.includes('dispatch.digest_matches_record')
    && negativeControl.errorCode === 'model_request_digest_mismatch'
    && negativeControl.transportDispatches === 0;
  const evidence: AtomicModelRequestEvidenceBundle = {
    schema: 'behavior-lab-atomic-model-request-evidence/v1',
    scenarioId: E4_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: resolveCommit(),
    claim: {
      ordering: 'assemble -> canonicalize -> append request record -> provider attempt -> dispatch',
      terminalPredicates: [
        'persisted envelope digest equals provider dispatch digest',
        'retry attempts share requestId and have distinct attemptId values',
        'post-persistence mutation is rejected before transport',
      ],
    },
    fixtures: { organization, researchLab, negativeControl },
    verdict: { correctedFixturePassed, negativeControlDetected, namedMismatches },
  };
  const schemaResult = atomicModelRequestEvidenceSchema.safeParse(evidence);
  const passed = correctedFixturePassed && negativeControlDetected && schemaResult.success;
  return {
    id: E4_ASSEMBLED_SCENARIO_ID,
    title: 'Recorded request equals provider dispatch',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `corrected=${correctedFixturePassed}; negativeControlDetected=${negativeControlDetected}; schema=${schemaResult.success}; mismatches=${namedMismatches.join(',')}${schemaResult.success ? '' : `; schemaErrors=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const atomicModelRequestScenario: AssembledBehaviorScenario<AtomicModelRequestEvidenceBundle> = {
  id: E4_ASSEMBLED_SCENARIO_ID,
  title: 'Recorded request equals provider dispatch',
  why: 'Persists the provider-decorated canonical envelope before two attempts, compares both transport captures, and proves a post-persistence tool-schema mutation is rejected by digest verification.',
  run,
};
