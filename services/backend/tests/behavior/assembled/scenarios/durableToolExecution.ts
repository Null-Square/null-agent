import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  type RuntimeHostCapabilities,
} from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import {
  normalizeToolExecutionStatus,
  type BlockToolExecutionInput,
  type CompleteToolExecutionInput,
  type CreateToolExecutionInput,
  type FailToolExecutionInput,
  type OutcomeUnknownToolExecutionInput,
  type ToolExecutionIdentity,
  type ToolExecutionPort,
  type ToolExecutionRecord,
} from '../../../../src/domains/agent-brain/ports';
import {
  getHostedRunToolExecutionLifecycle,
  registerHostedRunPersistencePort,
} from '../../../../src/domains/security-ops/runs/HostedRunPersistencePort';
import { InMemoryUsageStore } from '../../../../src/domains/platform/subscriptions/infrastructure/usageStores';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E3_ASSEMBLED_SCENARIO_ID =
  'harness-restart-does-not-duplicate-external-effect';

const FAULT_POINTS = [
  'after_claim',
  'after_start',
  'after_external_effect',
  'after_settle',
] as const;

type FaultPoint = typeof FAULT_POINTS[number];
type HostKind = 'organization' | 'research_lab';
type RecoveryOutcome = 'not_started' | 'outcome_unknown' | 'cached_success';

type SerializedRecord = Omit<
  ToolExecutionRecord,
  'claimedAt' | 'startedAt' | 'completedAt'
> & {
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
};

type CrashFixtureEvidence = {
  hostKind: HostKind;
  faultPoint: FaultPoint;
  capabilities: RuntimeHostCapabilities;
  selectedOwner: string;
  registeredHostedPort: boolean;
  coldRestartPerformed: true;
  eventOrder: string[];
  coldRecord: SerializedRecord;
  recoveryOutcome: RecoveryOutcome;
  externalEffectCount: number;
  cachedResult?: unknown;
  assertions: VerificationAssertion[];
  passed: boolean;
};

type HostCrashMatrixEvidence = {
  hostKind: HostKind;
  fixtures: CrashFixtureEvidence[];
  passed: boolean;
};

type NegativeFixtureEvidence = {
  hostKind: 'research_lab';
  eventOrder: string[];
  externalEffectCount: number;
  assertions: VerificationAssertion[];
  passed: boolean;
};

export type DurableToolExecutionEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-durable-tool-execution-evidence/v1';
  scenarioId: typeof E3_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  claim: {
    lifecycle: 'claimed -> started -> succeeded | failed | blocked | outcome_unknown';
    faultPoints: FaultPoint[];
    terminalPredicates: string[];
  };
  fixtures: {
    organization: HostCrashMatrixEvidence;
    researchLab: HostCrashMatrixEvidence;
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
const serializeRecord = (record: ToolExecutionRecord): SerializedRecord => ({
  ...clone(record),
  claimedAt: record.claimedAt?.toISOString(),
  startedAt: record.startedAt?.toISOString(),
  completedAt: record.completedAt?.toISOString(),
});
const deserializeRecord = (record: SerializedRecord): ToolExecutionRecord => ({
  ...clone(record),
  claimedAt: record.claimedAt ? new Date(record.claimedAt) : undefined,
  startedAt: record.startedAt ? new Date(record.startedAt) : undefined,
  completedAt: record.completedAt ? new Date(record.completedAt) : undefined,
});

class CrashMatrixLifecycle implements ToolExecutionPort {
  constructor(
    private readonly filePath: string,
    private readonly eventOrder: string[],
  ) {}

  async findByToolCallId(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const record = this.read().find(
      (candidate) => candidate.sessionId === sessionId && candidate.toolCallId === toolCallId,
    );
    return record ? deserializeRecord(record) : undefined;
  }

  async create(input: CreateToolExecutionInput): Promise<ToolExecutionRecord> {
    return (await this.claim(input)).record;
  }

  async claim(
    input: CreateToolExecutionInput,
  ): Promise<{ record: ToolExecutionRecord; claimed: boolean }> {
    const records = this.read();
    const existing = records.find(
      (candidate) => candidate.sessionId === input.sessionId
        && candidate.toolCallId === input.toolCallId,
    );
    if (existing) return { record: deserializeRecord(existing), claimed: false };
    const record: ToolExecutionRecord = {
      id: `execution-${input.toolCallId}`,
      ...clone(input),
      status: 'claimed',
      claimedAt: new Date(),
    };
    records.push(serializeRecord(record));
    this.write(records);
    this.eventOrder.push('claim.persisted');
    return { record, claimed: true };
  }

  async markStarted(input: ToolExecutionIdentity): Promise<void> {
    this.transition(input, ['claimed'], 'started', (record) => {
      record.status = 'started';
      record.startedAt = new Date().toISOString();
    });
    this.eventOrder.push('start.persisted');
  }

  async complete(input: CompleteToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'succeeded', (record) => {
      record.status = 'succeeded';
      record.result = clone(input.result);
      record.completedAt = new Date().toISOString();
      record.durationMs = input.durationMs;
    });
    this.eventOrder.push('settle.persisted');
  }

  async fail(input: FailToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'failed', (record) => {
      record.status = 'failed';
      record.error = input.error;
      record.completedAt = new Date().toISOString();
    });
  }

  async block(input: BlockToolExecutionInput): Promise<void> {
    this.transition(input, ['claimed', 'started'], 'blocked', (record) => {
      record.status = 'blocked';
      record.error = input.reason;
      record.completedAt = new Date().toISOString();
    });
  }

  async markOutcomeUnknown(input: OutcomeUnknownToolExecutionInput): Promise<void> {
    this.transition(input, ['started'], 'outcome_unknown', (record) => {
      record.status = 'outcome_unknown';
      record.error = input.reason;
      record.completedAt = new Date().toISOString();
    });
    this.eventOrder.push('outcome_unknown.persisted');
  }

  async findBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    return this.read()
      .filter((record) => record.sessionId === sessionId)
      .map(deserializeRecord);
  }

  async findByTurn(sessionId: string, turnId: string): Promise<ToolExecutionRecord[]> {
    return this.read()
      .filter((record) => record.sessionId === sessionId && record.turnId === turnId)
      .map(deserializeRecord);
  }

  private transition(
    input: ToolExecutionIdentity,
    allowed: string[],
    target: string,
    update: (record: SerializedRecord) => void,
  ): void {
    const records = this.read();
    const record = records.find(
      (candidate) => candidate.sessionId === input.sessionId
        && candidate.toolCallId === input.toolCallId,
    );
    const actual = record
      ? normalizeToolExecutionStatus(deserializeRecord(record))
      : 'missing';
    if (actual === target) return;
    if (!record || !allowed.includes(actual)) {
      throw new Error(`tool_execution_transition_rejected:${actual}->${target}`);
    }
    update(record);
    this.write(records);
  }

  private read(): SerializedRecord[] {
    if (!existsSync(this.filePath)) return [];
    return (JSON.parse(readFileSync(this.filePath, 'utf8')) as { records: SerializedRecord[] })
      .records;
  }

  private write(records: SerializedRecord[]): void {
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 2, records }, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.filePath);
  }
}

const capabilityFactory = (hostKind: HostKind): RuntimeHostCapabilities =>
  hostKind === 'organization'
    ? createOrganizationRuntimeHostCapabilities()
    : createResearchLabRuntimeHostCapabilities();

const incrementCounter = (counterPath: string, eventOrder: string[]): number => {
  const current = existsSync(counterPath)
    ? (JSON.parse(readFileSync(counterPath, 'utf8')) as { count: number }).count
    : 0;
  const count = current + 1;
  writeFileSync(counterPath, `${JSON.stringify({ count })}\n`, 'utf8');
  eventOrder.push('external_effect');
  return count;
};

const counterValue = (counterPath: string): number =>
  existsSync(counterPath)
    ? (JSON.parse(readFileSync(counterPath, 'utf8')) as { count: number }).count
    : 0;

const unusedModelRequestLifecycle = () => ({
  append: async () => { throw new Error('unused E3 model-request lifecycle'); },
  findByRequestId: async () => undefined,
  findBySession: async () => [],
});

const unusedHistoryTransformationLifecycle = () => ({
  prepare: async () => { throw new Error('unused E3 history transformation lifecycle'); },
  persistReplacement: async () => { throw new Error('unused E3 history transformation lifecycle'); },
  activate: async () => { throw new Error('unused E3 history transformation lifecycle'); },
  findById: async () => undefined,
  findActiveBySession: async () => undefined,
  findBySession: async () => [],
});

const runCrashFixture = async (
  hostKind: HostKind,
  faultPoint: FaultPoint,
): Promise<CrashFixtureEvidence> => {
  const root = mkdtempSync(path.join(os.tmpdir(), `null-ai-behavior-e3-${hostKind}-`));
  const ledgerPath = path.resolve(root, 'tool-executions.json');
  const counterPath = path.resolve(root, 'neutral-counter.json');
  const eventOrder: string[] = [];
  const live = new CrashMatrixLifecycle(ledgerPath, eventOrder);
  const capabilities = capabilityFactory(hostKind);
  const runId = `behavior-e3-${hostKind}-${faultPoint}`;
  let unregister: (() => void) | undefined;

  try {
    let selected: ToolExecutionPort = live;
    if (hostKind === 'research_lab') {
      unregister = registerHostedRunPersistencePort({
        kind: 'research_lab',
        runId,
        runtimeHostCapabilities: capabilities,
        toolExecutionLifecycle: live,
        modelRequestLifecycle: unusedModelRequestLifecycle(),
        providerAttemptLifecycle: new InMemoryUsageStore(),
        historyTransformationLifecycle: unusedHistoryTransformationLifecycle(),
      } as any);
      selected = getHostedRunToolExecutionLifecycle({
        runId,
        runHost: 'research_lab',
      }) ?? live;
    }

    const identity = {
      sessionId: `${hostKind}-session`,
      turnId: 'turn-1',
      toolCallId: 'neutral-call-1',
      toolName: 'neutral_counter',
      args: { amount: 1 },
    };
    await selected.claim?.(identity);
    if (faultPoint !== 'after_claim') {
      await selected.markStarted?.(identity);
      if (faultPoint !== 'after_start') {
        eventOrder.push('pre_tool_hook');
        incrementCounter(counterPath, eventOrder);
        if (faultPoint !== 'after_external_effect') {
          await selected.complete({ ...identity, result: { count: 1 } });
        }
      }
    }

    unregister?.();
    unregister = undefined;

    const cold = new CrashMatrixLifecycle(ledgerPath, eventOrder);
    const beforeRecovery = await cold.findByToolCallId(identity.sessionId, identity.toolCallId);
    if (!beforeRecovery) throw new Error('corrected fixture lost its durable claim');
    const coldStatus = normalizeToolExecutionStatus(beforeRecovery);
    let recoveryOutcome: RecoveryOutcome;
    let cachedResult: unknown;
    if (coldStatus === 'claimed') {
      recoveryOutcome = 'not_started';
    } else if (coldStatus === 'started') {
      await cold.markOutcomeUnknown({
        ...identity,
        reason: `cold restart after ${faultPoint}`,
      });
      recoveryOutcome = 'outcome_unknown';
    } else if (coldStatus === 'succeeded') {
      recoveryOutcome = 'cached_success';
      cachedResult = beforeRecovery.result;
    } else {
      recoveryOutcome = 'outcome_unknown';
    }
    const coldRecord = await cold.findByToolCallId(identity.sessionId, identity.toolCallId);
    if (!coldRecord) throw new Error('corrected fixture lost its cold lifecycle record');
    const externalEffectCount = counterValue(counterPath);
    const preHookIndex = eventOrder.indexOf('pre_tool_hook');
    const claimIndex = eventOrder.indexOf('claim.persisted');
    const expectedOutcome: RecoveryOutcome = faultPoint === 'after_claim'
      ? 'not_started'
      : faultPoint === 'after_settle'
        ? 'cached_success'
        : 'outcome_unknown';
    const assertions = [
      assertion(
        'ordering.claim_precedes_potentially_effecting_hook',
        claimIndex >= 0 && (preHookIndex < 0 || claimIndex < preHookIndex),
        'claim.persisted before pre_tool_hook',
        eventOrder,
        'tool-executions.json + fixture event order',
        'Ownership must be durable before a generic pre-tool hook can run.',
      ),
      assertion(
        'recovery.exposes_expected_outcome',
        recoveryOutcome === expectedOutcome,
        expectedOutcome,
        recoveryOutcome,
        'tool-executions.json',
        'Cold recovery decisions come from the lifecycle record rather than trace absence.',
      ),
      assertion(
        'external.effect_at_most_once',
        externalEffectCount <= 1,
        'count <= 1',
        externalEffectCount,
        'neutral-counter.json#/count',
        'Replaying the same call ID never duplicates the neutral effect.',
      ),
      assertion(
        'terminal.success_returns_original_result',
        faultPoint !== 'after_settle'
          || JSON.stringify(cachedResult) === JSON.stringify({ count: 1 }),
        faultPoint === 'after_settle' ? { count: 1 } : 'not_applicable',
        faultPoint === 'after_settle' ? cachedResult : 'not_applicable',
        'tool-executions.json#/records/0/result',
        'A settled success is replayed from its frozen result.',
      ),
    ];

    return {
      hostKind,
      faultPoint,
      capabilities,
      selectedOwner: capabilities.toolExecutions.owner,
      registeredHostedPort: hostKind === 'research_lab',
      coldRestartPerformed: true,
      eventOrder,
      coldRecord: serializeRecord(coldRecord),
      recoveryOutcome,
      externalEffectCount,
      ...(cachedResult !== undefined ? { cachedResult } : {}),
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    unregister?.();
    rmSync(root, { recursive: true, force: true });
  }
};

const runHostMatrix = async (hostKind: HostKind): Promise<HostCrashMatrixEvidence> => {
  const fixtures: CrashFixtureEvidence[] = [];
  for (const faultPoint of FAULT_POINTS) {
    fixtures.push(await runCrashFixture(hostKind, faultPoint));
  }
  return { hostKind, fixtures, passed: fixtures.every((fixture) => fixture.passed) };
};

const runNegativeControl = async (): Promise<NegativeFixtureEvidence> => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'null-ai-behavior-e3-negative-'));
  const ledgerPath = path.resolve(root, 'tool-executions.json');
  const counterPath = path.resolve(root, 'neutral-counter.json');
  const eventOrder: string[] = [];
  const lifecycle = new CrashMatrixLifecycle(ledgerPath, eventOrder);
  const capabilities = createResearchLabRuntimeHostCapabilities();
  const runId = 'behavior-e3-negative';
  const unregister = registerHostedRunPersistencePort({
    kind: 'research_lab',
    runId,
    runtimeHostCapabilities: capabilities,
    toolExecutionLifecycle: lifecycle,
    modelRequestLifecycle: unusedModelRequestLifecycle(),
    providerAttemptLifecycle: new InMemoryUsageStore(),
    historyTransformationLifecycle: unusedHistoryTransformationLifecycle(),
  } as any);

  try {
    const identity = {
      sessionId: 'negative-session',
      turnId: 'turn-1',
      toolCallId: 'negative-call-1',
      toolName: 'neutral_counter',
      args: { amount: 1 },
    };
    // Named fault: the effect occurs before ownership is persisted, then the process dies.
    incrementCounter(counterPath, eventOrder);
    const cold = new CrashMatrixLifecycle(ledgerPath, eventOrder);
    if (!await cold.findByToolCallId(identity.sessionId, identity.toolCallId)) {
      incrementCounter(counterPath, eventOrder);
      await cold.claim(identity);
      await cold.markStarted(identity);
      await cold.complete({ ...identity, result: { count: 2 } });
    }
    const externalEffectCount = counterValue(counterPath);
    const assertions = [
      assertion(
        'ordering.claim_precedes_external_effect',
        eventOrder.indexOf('claim.persisted') < eventOrder.indexOf('external_effect'),
        'claim.persisted before external_effect',
        eventOrder,
        'negative fixture event order',
        'The deliberately broken fixture performs the effect before claiming ownership.',
      ),
      assertion(
        'external.effect_at_most_once',
        externalEffectCount <= 1,
        'count <= 1',
        externalEffectCount,
        'neutral-counter.json#/count',
        'The gate must name the duplicate effect produced by claim-after-effect.',
      ),
    ];
    return {
      hostKind: 'research_lab',
      eventOrder,
      externalEffectCount,
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    unregister();
    rmSync(root, { recursive: true, force: true });
  }
};

const verificationAssertionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown(),
  actual: z.unknown(),
  authoritativeSource: z.string().min(1),
  detail: z.string().min(1),
});

const fixtureSchema = z.object({
  hostKind: z.enum(['organization', 'research_lab']),
  faultPoint: z.enum(FAULT_POINTS),
  capabilities: z.object({
    hostKind: z.enum(['organization', 'research_lab']),
    toolExecutions: z.object({
      owner: z.string().min(1),
      durability: z.literal('durable'),
      schemaVersion: z.literal(2),
    }),
  }).passthrough(),
  selectedOwner: z.string().min(1),
  registeredHostedPort: z.boolean(),
  coldRestartPerformed: z.literal(true),
  eventOrder: z.array(z.string().min(1)),
  coldRecord: z.object({
    toolCallId: z.string().min(1),
    status: z.enum(['claimed', 'started', 'succeeded', 'outcome_unknown']),
  }).passthrough(),
  recoveryOutcome: z.enum(['not_started', 'outcome_unknown', 'cached_success']),
  externalEffectCount: z.number().int().min(0).max(1),
  cachedResult: z.unknown().optional(),
  assertions: z.array(verificationAssertionSchema).min(1),
  passed: z.literal(true),
});

export const durableToolExecutionEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-durable-tool-execution-evidence/v1'),
  scenarioId: z.literal(E3_ASSEMBLED_SCENARIO_ID),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  claim: z.object({
    lifecycle: z.literal('claimed -> started -> succeeded | failed | blocked | outcome_unknown'),
    faultPoints: z.array(z.enum(FAULT_POINTS)).length(FAULT_POINTS.length),
    terminalPredicates: z.array(z.string().min(1)).min(1),
  }),
  fixtures: z.object({
    organization: z.object({
      hostKind: z.literal('organization'),
      fixtures: z.array(fixtureSchema).length(FAULT_POINTS.length),
      passed: z.literal(true),
    }),
    researchLab: z.object({
      hostKind: z.literal('research_lab'),
      fixtures: z.array(fixtureSchema).length(FAULT_POINTS.length),
      passed: z.literal(true),
    }),
    negativeControl: z.object({
      hostKind: z.literal('research_lab'),
      eventOrder: z.array(z.string().min(1)),
      externalEffectCount: z.number().int().min(2),
      assertions: z.array(verificationAssertionSchema).min(1),
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

const run = async (): Promise<AssembledScenarioResult<DurableToolExecutionEvidenceBundle>> => {
  const organization = await runHostMatrix('organization');
  const researchLab = await runHostMatrix('research_lab');
  const negativeControl = await runNegativeControl();
  const correctedFixturePassed = organization.passed && researchLab.passed;
  const namedMismatches = negativeControl.assertions
    .filter((entry) => !entry.passed)
    .map((entry) => entry.id);
  const negativeControlDetected = !negativeControl.passed
    && namedMismatches.includes('ordering.claim_precedes_external_effect')
    && namedMismatches.includes('external.effect_at_most_once');
  const evidence: DurableToolExecutionEvidenceBundle = {
    schema: 'behavior-lab-durable-tool-execution-evidence/v1',
    scenarioId: E3_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: resolveCommit(),
    claim: {
      lifecycle: 'claimed -> started -> succeeded | failed | blocked | outcome_unknown',
      faultPoints: [...FAULT_POINTS],
      terminalPredicates: [
        'claim persisted before pre_tool_hook',
        'claimed => not_started',
        'started without terminal => outcome_unknown',
        'succeeded => cached result',
      ],
    },
    fixtures: { organization, researchLab, negativeControl },
    verdict: { correctedFixturePassed, negativeControlDetected, namedMismatches },
  };
  const schemaResult = durableToolExecutionEvidenceSchema.safeParse(evidence);
  const passed = correctedFixturePassed && negativeControlDetected && schemaResult.success;

  return {
    id: E3_ASSEMBLED_SCENARIO_ID,
    title: 'Restart does not duplicate an external effect',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `corrected=${correctedFixturePassed}; negativeControlDetected=${negativeControlDetected}; schema=${schemaResult.success}; mismatches=${namedMismatches.join(',')}${schemaResult.success ? '' : `; schemaErrors=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const durableToolExecutionScenario: AssembledBehaviorScenario<DurableToolExecutionEvidenceBundle> = {
  id: E3_ASSEMBLED_SCENARIO_ID,
  title: 'Restart does not duplicate an external effect',
  why: 'Runs the claim/start/effect/settle crash matrix for organization and registered Research Lab owners, then proves a claim-after-effect control duplicates the neutral effect.',
  run,
};
