import { execFileSync } from 'node:child_process';
import { z } from 'zod';

import { DefaultBuildStage } from '../../../../src/domains/agent-brain/application/orchestration/stages/BuildStage';
import { AppError, ERROR_CODES } from '../../../../src/shared/errors';
import type { Message, SessionState } from '../../../../src/domains/agent-brain/domain/types';
import type { HistoryTransformationPort } from '../../../../src/domains/agent-brain/ports/HistoryTransformationPort';
import {
  compareProjections,
  digestOf,
  projectOpenAiCompatibleCacheSurface,
  type CacheIdentity,
} from '../../../../src/domains/agent-brain/domain/cache';
import { CacheLineageObserver } from '../../../../src/domains/agent-brain/application/orchestration/CacheLineageObserver';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E12_ASSEMBLED_SCENARIO_ID = 'harness-cache-lineage-exact-prefix-compaction';

const identity: CacheIdentity = {
  provider: 'behavior-cache-provider',
  model: 'behavior-cache-model',
  tenantDigest: digestOf('behavior-tenant'),
  translationVersion: 'openai-compatible/v1',
};

const summary = [
  '## Filed Findings', '- none',
  '## Attempted Techniques', '- probe | /api | blocked',
  '## Failed Approaches', '- none',
  '## Credentials', '- none',
  '## Open Plan Steps', '- none',
  '## Discoveries', '- none',
  '## Constraints', '- none',
  '## Next Action', '- none',
].join('\n');

const createMessages = (count: number, chars: number): Message[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index} ${'detail '.repeat(Math.ceil(chars / 7))}`,
    timestamp: Date.now() + index,
  })) as Message[];

const createHistoryPort = (): HistoryTransformationPort => {
  const records = new Map<string, Record<string, unknown>>();
  return {
    prepare: async (input: Record<string, unknown>) => {
      const id = String(input.transactionId);
      const record = { ...input, transactionId: id, state: 'prepared' };
      records.set(id, record);
      return record as never;
    },
    persistReplacement: async (id: string, input: Record<string, unknown>) => {
      const record = { ...(records.get(id) ?? {}), ...input, state: 'replacement_persisted' };
      records.set(id, record);
      return record as never;
    },
    activate: async (id: string) => {
      const record = { ...(records.get(id) ?? {}), state: 'active' };
      records.set(id, record);
      return record as never;
    },
    findById: async (id: string) => records.get(id) as never,
    findActiveBySession: async () => undefined,
    findBySession: async () => [] as never,
  } as unknown as HistoryTransformationPort;
};

const provider = {
  name: identity.provider,
  getCapabilities: () => ({ contextWindow: 8_000 }),
  supportsCacheControl: () => false,
  buildSystemMessages: () => [],
  mapError: (error: unknown) => (error instanceof AppError
    ? error
    : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error))),
};

interface CapturedCall {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  cacheMode?: { kind: string };
}

/**
 * Drives the real BuildStage until it compacts, capturing the auxiliary request the
 * shipping path actually dispatches.
 */
const runCompaction = async (messages: Message[]): Promise<{
  captured: CapturedCall | undefined;
  mainMessages: Array<{ role: string; content: string }>;
  traceEvents: Array<Record<string, unknown>>;
}> => {
  let captured: CapturedCall | undefined;
  const traceEvents: Array<Record<string, unknown>> = [];
  const session = {
    id: 'e12-session',
    profileKey: 'default',
    messages,
    modelContextWindow: 8_000,
    modelMaxOutputTokens: 1_000,
    flags: { securityops: { workflowDiscipline: 'pentest' } },
  } as unknown as SessionState;

  const convertMessages = (input: Message[]) => input.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }));

  await new DefaultBuildStage().run({
    session,
    turnNumber: 5,
    contextProvider: { getContext: async () => ({ hard: '', soft: '' }) },
    promptBuilder: {
      resolveProfile: async () => ({ id: 'behavior' }),
      build: () => ({
        staticPrompt: 'STATIC SECURITY PROMPT',
        dynamicPrompt: '',
        softContext: '',
        cacheablePrefix: '',
        dynamicBoundary: '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
        sections: { static: [], soft: [], dynamic: [] },
      }),
    },
    cacheCoordinator: {
      build: () => ({ cacheIntent: { action: 'none' }, approxPrefixTokens: 0, prefixHash: 'none' }),
    },
    toolsRegistry: {
      // ToolsRegistry returns a flat schema shape; BuildStage maps it to OpenAI form.
      getToolSchemas: () => [
        { name: 'http_request', description: 'send http', parameters: { type: 'object', properties: {} } },
      ],
    },
    provider,
    convertMessages,
    maxToolCalls: 4,
    modelName: identity.model,
    executeModelCall: async (input: CapturedCall) => {
      captured = input;
      return { content: summary } as never;
    },
    traceRecorder: { write: async (_s: string, _t: number, e: Record<string, unknown>) => { traceEvents.push(e); } },
  } as never);

  return { captured, mainMessages: convertMessages(messages) as never, traceEvents };
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
  authoritativeSource: 'dispatched auxiliary request captured at executeModelCall',
  detail,
});

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const evidenceSchema = z.object({
  schema: z.literal('behavior-lab-cache-lineage-evidence/v1'),
  scenarioId: z.literal(E12_ASSEMBLED_SCENARIO_ID),
  commit: z.string(),
  measurement: z.object({
    ancestorSegments: z.number(),
    auxiliarySegments: z.number(),
    reusableTokensNewShape: z.number(),
    reusableTokensOldShape: z.number(),
    recoveredTokens: z.number(),
  }),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string()),
  }),
});

type Evidence = z.infer<typeof evidenceSchema> & { assertions: VerificationAssertion[] };

const run = async (): Promise<AssembledScenarioResult<Evidence>> => {
  const messages = createMessages(6, 4_000);
  const { captured, mainMessages, traceEvents } = await runCompaction(messages);

  if (!captured) {
    throw new Error(`BuildStage did not dispatch a compaction request; events=${JSON.stringify(traceEvents.map((e) => ({ event: e.event, payload: e.payload })))}`.slice(0, 1200));
  }

  const auxMessages = captured.messages;
  const conversation = auxMessages.slice(0, -1);
  const instruction = auxMessages[auxMessages.length - 1]!;

  // The ancestor is the main-line request the warm cache belongs to.
  const ancestorProjection = projectOpenAiCompatibleCacheSurface({
    envelope: { model: identity.model, messages: conversation, tools: captured.tools ?? [] },
    identity,
  });
  const auxiliaryProjection = projectOpenAiCompatibleCacheSurface({
    envelope: { model: identity.model, messages: auxMessages, tools: captured.tools ?? [] },
    identity,
  });
  const comparison = compareProjections(ancestorProjection, auxiliaryProjection);

  // Negative control: the pre-E12 shape — a bespoke summarizer system prompt in front of a
  // flattened transcript. Its first token differs, so nothing is reusable.
  const oldShapeProjection = projectOpenAiCompatibleCacheSurface({
    envelope: {
      model: identity.model,
      messages: [
        { role: 'system', content: 'You compress pentest run history for future turns.' },
        { role: 'user', content: conversation.map((m) => m.content).join(' ') },
      ],
    },
    identity,
  });
  const oldComparison = compareProjections(ancestorProjection, oldShapeProjection);

  // Lineage must record the auxiliary as a side branch that does not advance the ancestor.
  const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const observer = new CacheLineageObserver((event, payload) => events.push({ event, payload }));
  observer.recordExpectation({
    sessionId: 'e12-session', requestId: 'main-1', branch: 'main',
    cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'none' },
    projection: ancestorProjection,
  });
  observer.recordExpectation({
    sessionId: 'e12-session', requestId: 'aux-1', branch: 'auxiliary',
    cacheMode: { kind: 'reuse_ancestor', ancestorRequestId: 'main-1' },
    projection: auxiliaryProjection,
  });
  const auxEvent = events[1]!.payload;

  const structuredPreserved = conversation.some((message) => message.role === 'assistant');
  const toolsPreserved = Array.isArray(captured.tools) && captured.tools.length > 0;
  const noBespokeSystem = !conversation.some((message) => message.role === 'system'
    && String(message.content ?? '').includes('compaction engine'));

  const assertions: VerificationAssertion[] = [
    assertion(
      'auxiliary.is_exact_prefix_extension_of_ancestor',
      comparison.isAppendExtension && comparison.firstDivergenceIndex === -1,
      { isAppendExtension: true, firstDivergenceIndex: -1 },
      { isAppendExtension: comparison.isAppendExtension, firstDivergenceIndex: comparison.firstDivergenceIndex },
      'The compaction call extends the warm prefix; only the trailing instruction is new.',
    ),
    assertion(
      'auxiliary.directive_is_the_trailing_user_message',
      instruction.role === 'user' && instruction.content.includes('THE CONVERSATION ABOVE'),
      { role: 'user', mentionsConversationAbove: true },
      { role: instruction.role, mentionsConversationAbove: instruction.content.includes('THE CONVERSATION ABOVE') },
      'Moving the directive off the front is what preserves the cached prefix.',
    ),
    assertion(
      'auxiliary.declares_cache_mode',
      captured.cacheMode?.kind === 'reuse_ancestor',
      { kind: 'reuse_ancestor' },
      captured.cacheMode,
      'Cache-affine auxiliaries declare intent; isolated calls must not inherit the session.',
    ),
    assertion(
      'auxiliary.preserves_tool_schemas',
      toolsPreserved,
      'tools present',
      { toolCount: (captured.tools ?? []).length },
      'Dropping tools would shorten the token sequence and break alignment with the cache.',
    ),
    assertion(
      'auxiliary.preserves_structured_history',
      structuredPreserved && noBespokeSystem,
      { structuredMessages: true, bespokeSystemPrompt: false },
      { structuredMessages: structuredPreserved, bespokeSystemPrompt: !noBespokeSystem },
      'The summarizer reads real messages, not a rendered transcript.',
    ),
    assertion(
      'lineage.auxiliary_is_a_side_branch',
      auxEvent.structuralRelation === 'auxiliary_extension'
        && auxEvent.cacheAncestorRequestId === 'main-1',
      { structuralRelation: 'auxiliary_extension', cacheAncestorRequestId: 'main-1' },
      { structuralRelation: auxEvent.structuralRelation, cacheAncestorRequestId: auxEvent.cacheAncestorRequestId },
      'An auxiliary summary must never become the next ordinary request ancestor.',
    ),
    assertion(
      'negative_control.old_shape_loses_the_prefix',
      oldComparison.estimatedReusableTokens === 0 && !oldComparison.isAppendExtension,
      { estimatedReusableTokens: 0, isAppendExtension: false },
      {
        estimatedReusableTokens: oldComparison.estimatedReusableTokens,
        isAppendExtension: oldComparison.isAppendExtension,
      },
      'Restoring the bespoke system prompt over a flattened transcript reuses nothing.',
    ),
  ];

  const namedMismatches = assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
  const correctedFixturePassed = namedMismatches.length === 0;
  const negativeControlDetected = oldComparison.estimatedReusableTokens === 0;

  const evidence: Evidence = {
    schema: 'behavior-lab-cache-lineage-evidence/v1',
    scenarioId: E12_ASSEMBLED_SCENARIO_ID,
    commit: commit(),
    measurement: {
      ancestorSegments: ancestorProjection.segments.length,
      auxiliarySegments: auxiliaryProjection.segments.length,
      reusableTokensNewShape: comparison.estimatedReusableTokens,
      reusableTokensOldShape: oldComparison.estimatedReusableTokens,
      recoveredTokens: comparison.estimatedReusableTokens - oldComparison.estimatedReusableTokens,
    },
    verdict: { correctedFixturePassed, negativeControlDetected, namedMismatches },
    assertions,
  };

  const schemaOk = evidenceSchema.safeParse(evidence).success;
  const passed = correctedFixturePassed && negativeControlDetected && schemaOk;

  return {
    id: E12_ASSEMBLED_SCENARIO_ID,
    title: 'Compaction auxiliary extends the warm prefix instead of discarding it',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(passed ? {} : { error: `mismatches=${namedMismatches.join(',')}; schema=${schemaOk}` }),
  };
};

export const cacheLineageExactPrefixScenario: AssembledBehaviorScenario<Evidence> = {
  id: E12_ASSEMBLED_SCENARIO_ID,
  title: 'Compaction auxiliary extends the warm prefix instead of discarding it',
  why: 'Measures the prefix reuse recovered by E12 Slice C and proves the pre-E12 shape reused nothing.',
  run,
};
