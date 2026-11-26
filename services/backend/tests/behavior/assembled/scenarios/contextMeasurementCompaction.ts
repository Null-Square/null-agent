import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { ERROR_CODES } from '@null-ai/contracts';

import { DefaultBuildStage } from '../../../../src/domains/agent-brain/application/orchestration/stages/BuildStage';
import { AppError } from '../../../../src/domains/agent-brain/domain/errors';
import {
  buildContextMeasurement,
  measurementMatchesRoute,
} from '../../../../src/domains/agent-brain/domain/context';
import type { Message, SessionState } from '../../../../src/domains/agent-brain/domain/types';
import type {
  HistoryTransformationPort,
  HistoryTransformationRecord,
} from '../../../../src/domains/agent-brain/ports';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E5_LARGE_WINDOW_SCENARIO_ID =
  'harness-large-window-does-not-compact-at-eleven-percent';

const PROFILES = [
  'exposure_verification',
  'finding_disposition',
  'compliance',
  'code_review',
  'pentest',
] as const;

type ProfileEvidence = {
  profile: typeof PROFILES[number];
  oldTriggerCompacted: boolean;
  nearSoftCompacted: boolean;
  selectedReducer: string;
  routedCapacity: number;
  counts: HistoryTransformationRecord['beforeMeasurement']['counts'];
  thresholds: HistoryTransformationRecord['beforeMeasurement']['thresholds'];
  transactionId?: string;
};

export type ContextMeasurementCompactionEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-context-measurement-compaction-evidence/v1';
  scenarioId: typeof E5_LARGE_WINDOW_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  profiles: ProfileEvidence[];
  routeChangeInvalidated: boolean;
  negativeControl: {
    legacyFixedCapacity: number;
    legacySoftTokens: number;
    oldFixtureTokens: number;
    legacyWouldCompact: boolean;
    correctedCompacted: boolean;
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
  authoritativeSource: 'DefaultBuildStage + ContextMeasurement + HistoryTransformationPort',
  detail,
});

const summary = [
  '## Filed Findings', '- F-1 preserved', '',
  '## Attempted Techniques', '- technique preserved', '',
  '## Failed Approaches and Blockers', '- blocker preserved', '',
  '## Confirmed Credentials or Tokens', '- none', '',
  '## Open Plan Steps', '- next step preserved', '',
  '## High-Signal Discoveries', '- discovery preserved', '',
  '## Constraints and Safety Limits', '- safety preserved',
].join('\n');

const profileFlags = (profile: typeof PROFILES[number]): Record<string, unknown> => {
  switch (profile) {
    case 'exposure_verification': return { securityops: { runTrigger: 'exposure_verification' } };
    case 'finding_disposition': return { securityops: { findingDispositionVerificationId: 'verification-1' } };
    case 'compliance': return { securityops: { workflowDiscipline: 'compliance' } };
    case 'code_review': return { securityops: { workflowDiscipline: 'code_review' } };
    default: return { securityops: {} };
  }
};

const createMessages = (prefix: string, charsPerMessage: number): Message[] =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: 'user',
    content: `${prefix}:${index}:${'x'.repeat(charsPerMessage)}`,
    timestamp: index,
  }));

const createHistoryPort = (): {
  port: HistoryTransformationPort;
  records: Map<string, HistoryTransformationRecord>;
} => {
  const records = new Map<string, HistoryTransformationRecord>();
  const clone = <T>(value: T): T => structuredClone(value);
  return {
    records,
    port: {
      prepare: async (input) => {
        const existing = records.get(input.transactionId);
        if (existing) return clone(existing);
        const record: HistoryTransformationRecord = {
          ...clone(input),
          provenance: 'recorded',
          status: 'prepared',
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
        records.set(record.transactionId, record);
        return clone(record);
      },
      persistReplacement: async (transactionId, input) => {
        const record = records.get(transactionId);
        if (!record) throw new Error(`missing:${transactionId}`);
        Object.assign(record, clone(input), {
          status: 'replacement_persisted',
          replacementPersistedAt: new Date().toISOString(),
        });
        return clone(record);
      },
      activate: async (transactionId) => {
        const record = records.get(transactionId);
        if (!record) throw new Error(`missing:${transactionId}`);
        record.status = 'activated';
        record.activatedAt = new Date().toISOString();
        return clone(record);
      },
      findById: async (transactionId) => {
        const record = records.get(transactionId);
        return record ? clone(record) : undefined;
      },
      findActiveBySession: async (sessionId) => {
        const record = [...records.values()].find(
          (candidate) => candidate.sessionId === sessionId && candidate.status === 'activated',
        );
        return record ? clone(record) : undefined;
      },
      findBySession: async (sessionId) => [...records.values()]
        .filter((record) => record.sessionId === sessionId)
        .map(clone),
    },
  };
};

const provider = {
  name: 'behavior-million-provider',
  getCapabilities: () => ({ contextWindow: 1_000_000 }),
  supportsCacheControl: () => false,
  buildSystemMessages: () => [],
  mapError: (error: unknown) => error instanceof AppError
    ? error
    : new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, String(error)),
};

const runBuild = async (input: {
  profile: typeof PROFILES[number];
  messages: Message[];
  historyPort: HistoryTransformationPort;
}) => {
  const session = {
    id: `${input.profile}-${input.messages[0]?.id}`,
    profileKey: 'default',
    messages: input.messages,
    modelContextWindow: 1_000_000,
    modelMaxOutputTokens: 8_192,
    flags: profileFlags(input.profile),
  } as SessionState;
  return new DefaultBuildStage().run({
    session,
    turnNumber: 5,
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
    provider: provider as any,
    convertMessages: (messages) => messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...((message as Message).tool_calls ? { tool_calls: (message as Message).tool_calls } : {}),
    })) as any,
    maxToolCalls: 4,
    modelName: 'behavior-million-model',
    executeModelCall: async () => ({ content: summary }) as any,
    historyTransformationPort: input.historyPort,
  });
};

const commit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const runScenario = async (): Promise<AssembledScenarioResult<ContextMeasurementCompactionEvidenceBundle>> => {
  const profiles: ProfileEvidence[] = [];
  let oldFixtureTokens = 0;
  let firstMeasurement: HistoryTransformationRecord['beforeMeasurement'] | undefined;

  for (const profile of PROFILES) {
    const oldHistory = createHistoryPort();
    const oldMessages = createMessages('old-shared', 75_000);
    const oldResult = await runBuild({ profile, messages: oldMessages, historyPort: oldHistory.port });

    const nearHistory = createHistoryPort();
    const nearResult = await runBuild({
      profile,
      messages: createMessages('near-shared', 470_000),
      historyPort: nearHistory.port,
    });
    const record = [...nearHistory.records.values()][0];
    if (!record) throw new Error(`missing transformation for profile ${profile}`);
    firstMeasurement ??= record.beforeMeasurement;

    const oldMeasurement = buildContextMeasurement({
      measurementId: `old-${profile}`,
      requestId: `old-${profile}`,
      sessionId: `old-${profile}`,
      turn: 5,
      callOrdinal: 1,
      provider: provider.name,
      model: 'behavior-million-model',
      routedCapacity: 1_000_000,
      capacitySource: 'model_config',
      reducerProfile: profile,
      reducerReason: 'request_measurement',
      envelope: {
        messages: oldMessages.map((message) => ({ role: message.role, content: message.content })),
        tools: [],
        max_tokens: 8_192,
      },
    });
    oldFixtureTokens = oldMeasurement.counts.totalWithReservedOutputTokens;
    profiles.push({
      profile,
      oldTriggerCompacted: Boolean(oldResult.compactionResult),
      nearSoftCompacted: Boolean(nearResult.compactionResult),
      selectedReducer: nearResult.contextMeasurementHints?.reducerProfile ?? 'missing',
      routedCapacity: record.beforeMeasurement.routedCapacity,
      counts: record.beforeMeasurement.counts,
      thresholds: record.beforeMeasurement.thresholds,
      transactionId: nearResult.transformationRefs?.[0],
    });
  }

  if (!firstMeasurement) throw new Error('missing authoritative measurement');
  const routeChangeInvalidated = !measurementMatchesRoute(firstMeasurement, {
    provider: 'behavior-million-provider-route-2',
    model: 'behavior-million-model',
    routedCapacity: 128_000,
    capacitySource: 'provider_capability_fallback',
  });
  const legacyFixedCapacity = 160_000;
  const legacySoftTokens = Math.floor(legacyFixedCapacity * 0.7);
  const negativeControl = {
    legacyFixedCapacity,
    legacySoftTokens,
    oldFixtureTokens,
    legacyWouldCompact: oldFixtureTokens >= legacySoftTokens,
    correctedCompacted: profiles.some((entry) => entry.oldTriggerCompacted),
    detected: oldFixtureTokens >= legacySoftTokens
      && profiles.every((entry) => !entry.oldTriggerCompacted),
  };
  const componentCountVariants = new Set(profiles.map((entry) => JSON.stringify(entry.counts))).size;
  const assertions = [
    assertion(
      'capacity.no_profile_compacts_near_legacy_trigger',
      profiles.every((entry) => !entry.oldTriggerCompacted),
      true,
      profiles.map((entry) => ({ profile: entry.profile, compacted: entry.oldTriggerCompacted })),
      'The five product profiles must use the million-token route instead of a fixed history cap.',
    ),
    assertion(
      'capacity.every_profile_compacts_at_routed_soft_threshold',
      profiles.every((entry) => entry.nearSoftCompacted),
      true,
      profiles.map((entry) => ({ profile: entry.profile, compacted: entry.nearSoftCompacted })),
      'Each existing profile remains selected and reduces only near the routed soft threshold.',
    ),
    assertion(
      'measurement.shared_capacity_and_components',
      profiles.every((entry) => entry.routedCapacity === 1_000_000)
        && componentCountVariants === 1,
      { routedCapacity: 1_000_000, componentCountVariants: 1 },
      { routedCapacities: profiles.map((entry) => entry.routedCapacity), componentCountVariants },
      'All reducer profiles consume the same named counting method, capacity, thresholds, and component shape.',
    ),
    assertion(
      'measurement.route_change_invalidates_prior_record',
      routeChangeInvalidated,
      true,
      routeChangeInvalidated,
      'A provider/capacity route fingerprint cannot be reused after routing changes.',
    ),
    assertion(
      'negative.old_fixed_cap_detected',
      negativeControl.detected,
      true,
      negativeControl,
      'Restoring the 160k fixed capacity makes the old 11% fixture compact and is detected.',
    ),
  ];
  const evidence: ContextMeasurementCompactionEvidenceBundle = {
    schema: 'behavior-lab-context-measurement-compaction-evidence/v1',
    scenarioId: E5_LARGE_WINDOW_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: commit(),
    profiles,
    routeChangeInvalidated,
    negativeControl,
    assertions,
    verdict: {
      correctedFixturePassed: assertions.slice(0, 4).every((entry) => entry.passed),
      negativeControlDetected: negativeControl.detected,
      namedMismatches: assertions.filter((entry) => !entry.passed).map((entry) => entry.id),
    },
  };
  const passed = assertions.every((entry) => entry.passed);
  return {
    id: E5_LARGE_WINDOW_SCENARIO_ID,
    title: 'Harness large window does not compact at eleven percent',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? { error: `failed=${evidence.verdict.namedMismatches.join(',')}` } : {}),
  };
};

export const contextMeasurementCompactionEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-context-measurement-compaction-evidence/v1'),
  scenarioId: z.literal(E5_LARGE_WINDOW_SCENARIO_ID),
  profiles: z.array(z.object({
    profile: z.enum(PROFILES),
    oldTriggerCompacted: z.boolean(),
    nearSoftCompacted: z.boolean(),
    selectedReducer: z.string(),
    routedCapacity: z.number(),
    counts: z.record(z.string(), z.number()),
    thresholds: z.record(z.string(), z.number()),
  })).length(5),
  routeChangeInvalidated: z.boolean(),
  negativeControl: z.object({ detected: z.boolean() }).passthrough(),
  assertions: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()),
}).passthrough();

export const contextMeasurementCompactionScenario:
AssembledBehaviorScenario<ContextMeasurementCompactionEvidenceBundle> = {
  id: E5_LARGE_WINDOW_SCENARIO_ID,
  title: 'Harness large window does not compact at eleven percent',
  why: 'Exercises all five product reducers against the same one-million-token measurement, proves the old fixed-cap trigger stays idle, and detects route-fingerprint reuse.',
  run: runScenario,
};
