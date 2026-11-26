import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import { z } from 'zod';

import {
  translateRequest,
  type OpenAIRequestBody,
} from '../../../../src/domains/agent-brain/adapters/providers/anthropic/requestTranslator';
import {
  sanitizeToolOrdering,
  validateMessageStructure,
} from '../../../../src/domains/agent-brain/application/orchestration/execution/TurnStreamController';
import {
  INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA,
  INTERRUPTED_TOOL_RESULT_SCHEMA,
  readInterruptedToolOutcome,
  type InterruptedToolExecutionEvidence,
  type InterruptedToolOutcome,
  type InterruptedToolRecoveryEventV1,
} from '../../../../src/domains/agent-brain/domain/recovery/interruptedToolResult';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E1_ASSEMBLED_SCENARIO_ID =
  'harness-interrupted-result-verifies-before-retry';

const TOOL_NAME = 'neutral_counter_increment';
const TOOL_CALL_ID = 'behavior-e1-counter-call';
const OLD_BLIND_RETRY_TEXT =
  'Tool execution was interrupted (session recovered after timeout or crash). Please retry the action.';

type FixtureKind = 'not_started' | 'started_without_terminal' | 'legacy_no_ledger';
type RecoveryMode = 'live' | 'cold';
type ProviderNextAction = 'retry_counter_increment' | 'verify_external_state';

type InterruptedFixtureEvidence = {
  fixture: FixtureKind;
  mode: RecoveryMode;
  interruptionBoundary: string;
  coldRestartPerformed: boolean;
  durableEvidence?: InterruptedToolExecutionEvidence;
  outcome: InterruptedToolOutcome | null;
  recoveryResult: Record<string, unknown>;
  recoveryEvents: InterruptedToolRecoveryEventV1[];
  providerNextAction: ProviderNextAction;
  providerResponse: string;
  providerAccepted: {
    openAiCompatible: boolean;
    anthropic: boolean;
  };
  toolResultCounts: {
    openAiCompatible: number;
    anthropic: number;
  };
  externalState: {
    beforeRecoveryResponse: number;
    afterRecoveryResponse: number;
  };
  noUnconditionalRetryInstruction: boolean;
  assertions: VerificationAssertion[];
  passed: boolean;
};

type InterruptedNegativeControlEvidence = {
  restoredText: string;
  providerHistoryValid: boolean;
  interpretedOutcome: InterruptedToolOutcome | null;
  providerNextAction: ProviderNextAction;
  assertions: VerificationAssertion[];
  passed: boolean;
};

export type InterruptedResultEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-interrupted-result-evidence/v1';
  scenarioId: typeof E1_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  configuration: {
    deterministicProvider: true;
    liveCanaryRequired: false;
    toolName: typeof TOOL_NAME;
    toolCallId: typeof TOOL_CALL_ID;
    compatibilityVersion: typeof INTERRUPTED_TOOL_RESULT_SCHEMA;
  };
  fixtures: {
    live: InterruptedFixtureEvidence[];
    cold: InterruptedFixtureEvidence[];
    negativeControl: InterruptedNegativeControlEvidence;
  };
};

const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('not_started'),
    guidance: z.literal('may_retry'),
    evidenceRef: z.string().min(1),
  }),
  z.object({
    kind: z.literal('outcome_unknown'),
    guidance: z.literal('verify_before_retry'),
    evidenceRef: z.string().min(1).optional(),
  }),
]);

const assertionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown(),
  actual: z.unknown(),
  authoritativeSource: z.string().min(1),
  detail: z.string().min(1),
});

const fixtureSchema = z.object({
  fixture: z.enum(['not_started', 'started_without_terminal', 'legacy_no_ledger']),
  mode: z.enum(['live', 'cold']),
  interruptionBoundary: z.string().min(1),
  coldRestartPerformed: z.boolean(),
  durableEvidence: z.object({
    dispatchState: z.enum(['not_started', 'started', 'unknown']),
    evidenceRef: z.string().optional(),
  }).optional(),
  outcome: outcomeSchema.nullable(),
  recoveryResult: z.record(z.unknown()),
  recoveryEvents: z.array(z.object({
    schema: z.literal(INTERRUPTED_TOOL_RECOVERY_EVENT_SCHEMA),
    toolCallId: z.string().min(1),
    source: z.string().min(1),
    decision: z.enum(['not_started', 'outcome_unknown']),
    compatibilityVersion: z.literal(INTERRUPTED_TOOL_RESULT_SCHEMA),
    evidenceRef: z.string().min(1).optional(),
  })),
  providerNextAction: z.enum(['retry_counter_increment', 'verify_external_state']),
  providerResponse: z.string().min(1),
  providerAccepted: z.object({ openAiCompatible: z.boolean(), anthropic: z.boolean() }),
  toolResultCounts: z.object({
    openAiCompatible: z.number().int().nonnegative(),
    anthropic: z.number().int().nonnegative(),
  }),
  externalState: z.object({
    beforeRecoveryResponse: z.number().int().nonnegative(),
    afterRecoveryResponse: z.number().int().nonnegative(),
  }),
  noUnconditionalRetryInstruction: z.boolean(),
  assertions: z.array(assertionSchema).min(1),
  passed: z.boolean(),
});

export const interruptedResultEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-interrupted-result-evidence/v1'),
  scenarioId: z.literal(E1_ASSEMBLED_SCENARIO_ID),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  configuration: z.object({
    deterministicProvider: z.literal(true),
    liveCanaryRequired: z.literal(false),
    toolName: z.literal(TOOL_NAME),
    toolCallId: z.literal(TOOL_CALL_ID),
    compatibilityVersion: z.literal(INTERRUPTED_TOOL_RESULT_SCHEMA),
  }),
  fixtures: z.object({
    live: z.array(fixtureSchema).length(3),
    cold: z.array(fixtureSchema).length(3),
    negativeControl: z.object({
      restoredText: z.string().min(1),
      providerHistoryValid: z.boolean(),
      interpretedOutcome: outcomeSchema.nullable(),
      providerNextAction: z.enum(['retry_counter_increment', 'verify_external_state']),
      assertions: z.array(assertionSchema).min(1),
      passed: z.boolean(),
    }),
  }),
  verdict: z.object({
    correctedFixturePassed: z.boolean(),
    negativeControlDetected: z.boolean(),
    namedMismatches: z.array(z.string().min(1)),
  }),
});

const fixtureDefinitions: Array<{
  fixture: FixtureKind;
  interruptionBoundary: string;
  durableEvidence?: InterruptedToolExecutionEvidence;
  initialExternalCount: number;
}> = [
  {
    fixture: 'not_started',
    interruptionBoundary: 'before_dispatch_claim',
    durableEvidence: {
      dispatchState: 'not_started',
      evidenceRef: 'ledger://behavior-e1/not-started/dispatch',
    },
    initialExternalCount: 0,
  },
  {
    fixture: 'started_without_terminal',
    interruptionBoundary: 'after_dispatch_claim_before_terminal_result',
    durableEvidence: {
      dispatchState: 'started',
      evidenceRef: 'ledger://behavior-e1/started/claim',
    },
    initialExternalCount: 1,
  },
  {
    fixture: 'legacy_no_ledger',
    interruptionBoundary: 'legacy_history_without_execution_ledger',
    initialExternalCount: 1,
  },
];

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

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  authoritativeSource: string,
  detail: string,
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

const parseRecord = (content: unknown): Record<string, unknown> => {
  if (typeof content !== 'string') return {};
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const buildInterruptedHistory = (): OpenAI.Chat.ChatCompletionMessageParam[] => [
  { role: 'user', content: 'Increment the neutral counter exactly once.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{
      id: TOOL_CALL_ID,
      type: 'function',
      function: { name: TOOL_NAME, arguments: '{"amount":1}' },
    }],
  },
];

const readCounter = (counterPath: string): number =>
  (JSON.parse(readFileSync(counterPath, 'utf8')) as { count: number }).count;

const writeCounter = (counterPath: string, count: number): void => {
  writeFileSync(counterPath, `${JSON.stringify({ count })}\n`, 'utf8');
};

class DeterministicRecoveryProvider {
  respond(outcome: InterruptedToolOutcome | undefined, counterPath: string): {
    action: ProviderNextAction;
    response: string;
  } {
    if (outcome?.kind === 'not_started' && outcome.guidance === 'may_retry') {
      writeCounter(counterPath, readCounter(counterPath) + 1);
      return {
        action: 'retry_counter_increment',
        response: 'The durable result proves dispatch did not start; retry the neutral increment.',
      };
    }
    return {
      action: 'verify_external_state',
      response: 'The outcome is unknown; verify the neutral counter before another call.',
    };
  }
}

const countAnthropicResults = (
  messages: ReturnType<typeof translateRequest>['messages'],
): number => messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
  .filter((block) => block.type === 'tool_result' && block.tool_use_id === TOOL_CALL_ID)
  .length;

const runFixture = (
  definition: typeof fixtureDefinitions[number],
  mode: RecoveryMode,
): InterruptedFixtureEvidence => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), `null-ai-behavior-e1-${mode}-`));
  const snapshotPath = path.join(fixtureRoot, 'recovery-snapshot.json');
  const counterPath = path.join(fixtureRoot, 'neutral-counter.json');
  const provider = new DeterministicRecoveryProvider();

  try {
    writeCounter(counterPath, definition.initialExternalCount);
    let messages = buildInterruptedHistory();
    let durableEvidence = definition.durableEvidence;
    if (mode === 'cold') {
      writeFileSync(snapshotPath, JSON.stringify({ messages, durableEvidence }), 'utf8');
      const restored = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
        messages: OpenAI.Chat.ChatCompletionMessageParam[];
        durableEvidence?: InterruptedToolExecutionEvidence;
      };
      messages = restored.messages;
      durableEvidence = restored.durableEvidence;
    }

    const repaired = sanitizeToolOrdering(messages, {
      source: mode === 'cold'
        ? 'behavior_lab_cold_recovery'
        : 'behavior_lab_live_repair',
      resolveEvidence: (toolCallId) => toolCallId === TOOL_CALL_ID
        ? durableEvidence
        : undefined,
    });
    const toolMessages = repaired.messages.filter((message) =>
      message.role === 'tool' && message.tool_call_id === TOOL_CALL_ID);
    const toolContent = toolMessages[0]?.content;
    const outcome = readInterruptedToolOutcome(toolContent);
    const recoveryResult = parseRecord(toolContent);
    const openAiValidation = validateMessageStructure(repaired.messages);
    const anthropicRequest = translateRequest({
      model: 'claude-behavior-e1',
      messages: repaired.messages as unknown as OpenAIRequestBody['messages'],
    });
    const anthropicResultCount = countAnthropicResults(anthropicRequest.messages);
    const beforeRecoveryResponse = readCounter(counterPath);
    const providerResponse = provider.respond(outcome, counterPath);
    const afterRecoveryResponse = readCounter(counterPath);
    const expectedOutcome = definition.fixture === 'not_started'
      ? 'not_started'
      : 'outcome_unknown';
    const expectedGuidance = definition.fixture === 'not_started'
      ? 'may_retry'
      : 'verify_before_retry';
    const expectedAction: ProviderNextAction = definition.fixture === 'not_started'
      ? 'retry_counter_increment'
      : 'verify_external_state';
    const noUnconditionalRetryInstruction = typeof toolContent === 'string'
      && !toolContent.includes('Please retry the action');
    const assertions = [
      assertion(
        'recovery.typed_outcome',
        outcome?.kind === expectedOutcome && outcome.guidance === expectedGuidance,
        { kind: expectedOutcome, guidance: expectedGuidance },
        outcome ?? null,
        `${mode}-recovery-result#/outcome`,
        'Only an explicit durable not-started fact grants retry guidance.',
      ),
      assertion(
        'recovery.exactly_one_event',
        repaired.recoveryEvents.length === 1
          && repaired.recoveryEvents[0]?.compatibilityVersion === INTERRUPTED_TOOL_RESULT_SCHEMA,
        { count: 1, compatibilityVersion: INTERRUPTED_TOOL_RESULT_SCHEMA },
        repaired.recoveryEvents,
        `${mode}-recovery-trace`,
        'Each repaired call records one source and decision event.',
      ),
      assertion(
        'provider.openai_compatible_exactly_one_result',
        openAiValidation.valid && toolMessages.length === 1,
        { valid: true, resultCount: 1 },
        { valid: openAiValidation.valid, issues: openAiValidation.issues, resultCount: toolMessages.length },
        'TurnStreamController.validateMessageStructure',
        'The repaired OpenAI-compatible history has one result for the original call ID.',
      ),
      assertion(
        'provider.anthropic_exactly_one_result',
        anthropicResultCount === 1,
        1,
        anthropicResultCount,
        'Anthropic request translator output',
        'The Anthropic projection has one matching tool_result block.',
      ),
      assertion(
        'recovery.no_unconditional_retry_instruction',
        noUnconditionalRetryInstruction,
        'no blind retry instruction',
        toolContent,
        `${mode}-recovery-result`,
        'Recovery prose must not restore the legacy unconditional retry command.',
      ),
      assertion(
        'provider.response_obeys_typed_guidance',
        providerResponse.action === expectedAction,
        expectedAction,
        providerResponse.action,
        'DeterministicRecoveryProvider response',
        'The provider retries only the proven-not-started fixture and verifies unknown outcomes.',
      ),
      assertion(
        'external.neutral_increment_not_duplicated',
        afterRecoveryResponse === 1,
        1,
        afterRecoveryResponse,
        'neutral-counter.json#/count',
        'Recovery leaves exactly one neutral non-idempotent effect in external state.',
      ),
    ];

    return {
      fixture: definition.fixture,
      mode,
      interruptionBoundary: definition.interruptionBoundary,
      coldRestartPerformed: mode === 'cold',
      ...(durableEvidence ? { durableEvidence } : {}),
      outcome: outcome ?? null,
      recoveryResult,
      recoveryEvents: repaired.recoveryEvents,
      providerNextAction: providerResponse.action,
      providerResponse: providerResponse.response,
      providerAccepted: {
        openAiCompatible: openAiValidation.valid,
        anthropic: anthropicResultCount === 1,
      },
      toolResultCounts: {
        openAiCompatible: toolMessages.length,
        anthropic: anthropicResultCount,
      },
      externalState: { beforeRecoveryResponse, afterRecoveryResponse },
      noUnconditionalRetryInstruction,
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};

const runNegativeControl = (): InterruptedNegativeControlEvidence => {
  const negativeContent = JSON.stringify({ error: OLD_BLIND_RETRY_TEXT, recovered: true });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...buildInterruptedHistory(),
    {
      role: 'tool' as const,
      tool_call_id: TOOL_CALL_ID,
      content: negativeContent,
    },
  ];
  const validation = validateMessageStructure(messages);
  const interpretedOutcome = readInterruptedToolOutcome(messages[2]!.content);
  const providerNextAction: ProviderNextAction = interpretedOutcome?.kind === 'not_started'
    ? 'retry_counter_increment'
    : 'verify_external_state';
  const assertions = [
    assertion(
      'provider.legacy_history_still_valid',
      validation.valid,
      true,
      validation,
      'TurnStreamController.validateMessageStructure',
      'The negative control isolates unsafe semantics rather than provider ordering.',
    ),
    assertion(
      'recovery.no_unconditional_retry_instruction',
      !negativeContent.includes('Please retry the action'),
      'no blind retry instruction',
      negativeContent,
      'negative-control tool result',
      'The named negative restores the old unconditional retry text and must fail.',
    ),
    assertion(
      'recovery.current_compatibility_version',
      parseRecord(negativeContent).schema === INTERRUPTED_TOOL_RESULT_SCHEMA,
      INTERRUPTED_TOOL_RESULT_SCHEMA,
      parseRecord(negativeContent).schema,
      'negative-control tool result',
      'New recovery writes must use the E1 compatibility version.',
    ),
  ];
  return {
    restoredText: OLD_BLIND_RETRY_TEXT,
    providerHistoryValid: validation.valid,
    interpretedOutcome: interpretedOutcome ?? null,
    providerNextAction,
    assertions,
    passed: assertions.every((entry) => entry.passed),
  };
};

const run = async (): Promise<AssembledScenarioResult<InterruptedResultEvidenceBundle>> => {
  const live = fixtureDefinitions.map((definition) => runFixture(definition, 'live'));
  const cold = fixtureDefinitions.map((definition) => runFixture(definition, 'cold'));
  const parityAssertions = fixtureDefinitions.map((definition) => {
    const liveFixture = live.find((fixture) => fixture.fixture === definition.fixture)!;
    const coldFixture = cold.find((fixture) => fixture.fixture === definition.fixture)!;
    return assertion(
      `recovery.live_cold_parity.${definition.fixture}`,
      JSON.stringify(liveFixture.recoveryResult) === JSON.stringify(coldFixture.recoveryResult)
        && liveFixture.providerNextAction === coldFixture.providerNextAction,
      {
        recoveryResult: liveFixture.recoveryResult,
        providerNextAction: liveFixture.providerNextAction,
      },
      {
        recoveryResult: coldFixture.recoveryResult,
        providerNextAction: coldFixture.providerNextAction,
      },
      'live and cold recovery projections',
      'Cold reconstruction must make the same decision and provider guidance as live repair.',
    );
  });
  const negativeControl = runNegativeControl();
  const correctedFixturePassed = [...live, ...cold].every((fixture) => fixture.passed)
    && parityAssertions.every((entry) => entry.passed);
  const namedMismatches = negativeControl.assertions
    .filter((entry) => !entry.passed)
    .map((entry) => entry.id);
  const negativeControlDetected = !negativeControl.passed
    && namedMismatches.includes('recovery.no_unconditional_retry_instruction');
  const evidence: InterruptedResultEvidenceBundle = {
    schema: 'behavior-lab-interrupted-result-evidence/v1',
    scenarioId: E1_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: resolveCommit(),
    configuration: {
      deterministicProvider: true,
      liveCanaryRequired: false,
      toolName: TOOL_NAME,
      toolCallId: TOOL_CALL_ID,
      compatibilityVersion: INTERRUPTED_TOOL_RESULT_SCHEMA,
    },
    fixtures: { live, cold, negativeControl },
    verdict: { correctedFixturePassed, negativeControlDetected, namedMismatches },
  };
  const schemaResult = interruptedResultEvidenceSchema.safeParse(evidence);
  const passed = correctedFixturePassed && negativeControlDetected && schemaResult.success;

  return {
    id: E1_ASSEMBLED_SCENARIO_ID,
    title: 'Interrupted results require verification before retry',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `corrected=${correctedFixturePassed}; negativeControlDetected=${negativeControlDetected}; schema=${schemaResult.success}${schemaResult.success ? '' : `; schemaErrors=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const interruptedResultSafetyScenario: AssembledBehaviorScenario<InterruptedResultEvidenceBundle> = {
  id: E1_ASSEMBLED_SCENARIO_ID,
  title: 'Interrupted results require verification before retry',
  why: 'Proves that only durable not-started evidence permits retry, while started and legacy histories require external-state verification after both live and cold repair.',
  run,
};
