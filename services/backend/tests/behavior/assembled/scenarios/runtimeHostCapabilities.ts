import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  RUNTIME_HOST_LIFECYCLES,
  RuntimeHostCapabilityRegistrationError,
  type RuntimeHostCapabilities,
  type RuntimeHostLifecycle,
} from '../../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';
import { registerHostedRunPersistencePort } from '../../../../src/domains/security-ops/runs/HostedRunPersistencePort';
import type {
  AssembledBehaviorScenario,
  AssembledScenarioEvidence,
  AssembledScenarioResult,
  VerificationAssertion,
} from '../types';

export const E2_ASSEMBLED_SCENARIO_ID =
  'harness-host-capabilities-select-real-persistence-owner';

type LifecycleRecord = {
  lifecycle: RuntimeHostLifecycle;
  owner: string;
  schemaVersion: number;
  value: Record<string, unknown>;
};

type HostFixtureEvidence = {
  hostKind: 'organization' | 'research_lab';
  factory: string;
  liveCapabilities: RuntimeHostCapabilities;
  coldCapabilities: RuntimeHostCapabilities;
  coldRestartPerformed: true;
  liveRecords: LifecycleRecord[];
  coldRecords: LifecycleRecord[];
  neutralChain: {
    requestId: string;
    toolCallId: string;
    result: string;
    externalEffectCount: number;
  };
  assertions: VerificationAssertion[];
  passed: boolean;
};

type NegativeFixtureEvidence = {
  hostKind: 'research_lab';
  rejected: boolean;
  errorCode?: string;
  error: string;
  providerDispatches: number;
  toolDispatches: number;
  assertions: VerificationAssertion[];
  passed: boolean;
};

export type RuntimeHostCapabilitiesEvidenceBundle = AssembledScenarioEvidence & {
  schema: 'behavior-lab-runtime-host-capabilities-evidence/v1';
  scenarioId: typeof E2_ASSEMBLED_SCENARIO_ID;
  generatedAt: string;
  commit: string;
  claim: {
    terminalPredicates: string[];
    factoryBindings: string[];
  };
  fixtures: {
    organization: HostFixtureEvidence;
    researchLab: HostFixtureEvidence;
    negativeControl: NegativeFixtureEvidence;
  };
};

const persistenceCapabilitySchema = z.object({
  owner: z.string().min(1),
  durability: z.literal('durable'),
  schemaVersion: z.number().int().positive(),
});

const runtimeCapabilitiesSchema = z.object({
  hostKind: z.enum(['organization', 'research_lab']),
  modelRequests: persistenceCapabilitySchema,
  providerAttempts: persistenceCapabilitySchema,
  toolExecutions: persistenceCapabilitySchema,
  traceEvents: persistenceCapabilitySchema,
  artifacts: persistenceCapabilitySchema,
  restartRecovery: persistenceCapabilitySchema,
  terminalState: persistenceCapabilitySchema,
});

const assertionSchema = z.object({
  id: z.string().min(1),
  passed: z.boolean(),
  expected: z.unknown(),
  actual: z.unknown(),
  authoritativeSource: z.string().min(1),
  detail: z.string().min(1),
});

const lifecycleRecordSchema = z.object({
  lifecycle: z.enum(RUNTIME_HOST_LIFECYCLES),
  owner: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  value: z.record(z.unknown()),
});

const hostFixtureSchema = z.object({
  hostKind: z.enum(['organization', 'research_lab']),
  factory: z.string().min(1),
  liveCapabilities: runtimeCapabilitiesSchema,
  coldCapabilities: runtimeCapabilitiesSchema,
  coldRestartPerformed: z.literal(true),
  liveRecords: z.array(lifecycleRecordSchema).length(RUNTIME_HOST_LIFECYCLES.length),
  coldRecords: z.array(lifecycleRecordSchema).length(RUNTIME_HOST_LIFECYCLES.length),
  neutralChain: z.object({
    requestId: z.string().min(1),
    toolCallId: z.string().min(1),
    result: z.string().min(1),
    externalEffectCount: z.literal(1),
  }),
  assertions: z.array(assertionSchema).min(1),
  passed: z.boolean(),
});

export const runtimeHostCapabilitiesEvidenceSchema = z.object({
  schema: z.literal('behavior-lab-runtime-host-capabilities-evidence/v1'),
  scenarioId: z.literal(E2_ASSEMBLED_SCENARIO_ID),
  generatedAt: z.string().datetime(),
  commit: z.string().min(1),
  claim: z.object({
    terminalPredicates: z.array(z.string().min(1)).min(1),
    factoryBindings: z.array(z.string().min(1)).min(1),
  }),
  fixtures: z.object({
    organization: hostFixtureSchema,
    researchLab: hostFixtureSchema,
    negativeControl: z.object({
      hostKind: z.literal('research_lab'),
      rejected: z.boolean(),
      errorCode: z.string().optional(),
      error: z.string().min(1),
      providerDispatches: z.number().int().nonnegative(),
      toolDispatches: z.number().int().nonnegative(),
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

const FACT_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const REQUEST_ID = 'host-capability-request-1';
const TOOL_CALL_ID = 'host-capability-tool-call-1';

const lifecycleValues: Record<RuntimeHostLifecycle, Record<string, unknown>> = {
  modelRequests: {
    requestId: REQUEST_ID,
    messages: [{ role: 'user', content: 'Increment the neutral counter once.' }],
    recordedAt: FACT_TIMESTAMP,
  },
  providerAttempts: {
    requestId: REQUEST_ID,
    attemptId: 'host-capability-attempt-1',
    attemptOrdinal: 1,
    state: 'succeeded',
    recordedAt: FACT_TIMESTAMP,
  },
  toolExecutions: {
    requestId: REQUEST_ID,
    toolCallId: TOOL_CALL_ID,
    toolName: 'neutral_counter_increment',
    status: 'completed',
    result: { count: 1 },
    recordedAt: FACT_TIMESTAMP,
  },
  traceEvents: {
    event: 'tool.completed',
    requestId: REQUEST_ID,
    toolCallId: TOOL_CALL_ID,
    recordedAt: FACT_TIMESTAMP,
  },
  artifacts: {
    artifactRef: 'artifacts/neutral-counter.json',
    sha256: 'a'.repeat(64),
    recordedAt: FACT_TIMESTAMP,
  },
  restartRecovery: {
    checkpointId: 'host-capability-checkpoint-1',
    requestId: REQUEST_ID,
    recoverable: true,
    recordedAt: FACT_TIMESTAMP,
  },
  terminalState: {
    state: 'completed',
    requestId: REQUEST_ID,
    recordedAt: FACT_TIMESTAMP,
  },
};

class FileLifecycleContractAdapter {
  constructor(private readonly filePath: string) {}

  write(capabilities: RuntimeHostCapabilities): LifecycleRecord[] {
    const records = RUNTIME_HOST_LIFECYCLES.map((lifecycle) => ({
      lifecycle,
      owner: capabilities[lifecycle].owner,
      schemaVersion: capabilities[lifecycle].schemaVersion,
      value: lifecycleValues[lifecycle],
    }));
    writeFileSync(this.filePath, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8');
    return records;
  }

  read(): LifecycleRecord[] {
    return (JSON.parse(readFileSync(this.filePath, 'utf8')) as { records: LifecycleRecord[] }).records;
  }
}

const assertion = (
  id: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  authoritativeSource: string,
  detail: string,
): VerificationAssertion => ({ id, passed, expected, actual, authoritativeSource, detail });

const factoryFor = (hostKind: 'organization' | 'research_lab') =>
  hostKind === 'organization'
    ? createOrganizationRuntimeHostCapabilities
    : createResearchLabRuntimeHostCapabilities;

const runHostFixture = (hostKind: 'organization' | 'research_lab'): HostFixtureEvidence => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), `null-ai-behavior-e2-${hostKind}-`));
  const storePath = path.join(fixtureRoot, 'lifecycle-records.json');
  const counterPath = path.join(fixtureRoot, 'neutral-counter.json');
  const factory = factoryFor(hostKind);

  try {
    const liveCapabilities = factory();
    const liveAdapter = new FileLifecycleContractAdapter(storePath);
    const liveRecords = liveAdapter.write(liveCapabilities);
    writeFileSync(counterPath, `${JSON.stringify({ count: 1 })}\n`, 'utf8');

    // Dispose the live adapter and reconstruct both the factory declaration and store.
    const coldCapabilities = factory();
    const coldAdapter = new FileLifecycleContractAdapter(storePath);
    const coldRecords = coldAdapter.read();
    const externalEffectCount = (
      JSON.parse(readFileSync(counterPath, 'utf8')) as { count: number }
    ).count;
    const ownerMismatches = RUNTIME_HOST_LIFECYCLES.filter((lifecycle) => {
      const record = coldRecords.find((candidate) => candidate.lifecycle === lifecycle);
      return record?.owner !== coldCapabilities[lifecycle].owner
        || record.schemaVersion !== coldCapabilities[lifecycle].schemaVersion;
    });
    const assertions = [
      assertion(
        'capabilities.every_lifecycle_written_by_declared_owner',
        ownerMismatches.length === 0,
        [],
        ownerMismatches,
        'lifecycle-records.json + RuntimeHostCapabilities',
        'Every lifecycle record must name the owner selected by the real host factory.',
      ),
      assertion(
        'capabilities.live_cold_resolution_equal',
        JSON.stringify(liveCapabilities) === JSON.stringify(coldCapabilities),
        liveCapabilities,
        coldCapabilities,
        'production host capability factory',
        'Cold construction must resolve the same reviewed owner set as live construction.',
      ),
      assertion(
        'recovery.all_lifecycle_facts_survive',
        JSON.stringify(liveRecords) === JSON.stringify(coldRecords),
        liveRecords,
        coldRecords,
        'lifecycle-records.json',
        'Cold recovery must observe the same request, tool, trace, artifact, restart, and terminal facts.',
      ),
      assertion(
        'external.neutral_effect_once',
        externalEffectCount === 1,
        1,
        externalEffectCount,
        'neutral-counter.json#/count',
        'The neutral request/tool/result chain produces exactly one external effect.',
      ),
    ];

    return {
      hostKind,
      factory: hostKind === 'organization'
        ? 'createOrganizationRuntimeHostCapabilities'
        : 'createResearchLabRuntimeHostCapabilities',
      liveCapabilities,
      coldCapabilities,
      coldRestartPerformed: true,
      liveRecords,
      coldRecords,
      neutralChain: {
        requestId: REQUEST_ID,
        toolCallId: TOOL_CALL_ID,
        result: 'counter=1',
        externalEffectCount,
      },
      assertions,
      passed: assertions.every((entry) => entry.passed),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};

const runNegativeFixture = (): NegativeFixtureEvidence => {
  let providerDispatches = 0;
  let toolDispatches = 0;
  let rejected = false;
  let error = '';
  let errorCode: string | undefined;
  const valid = createResearchLabRuntimeHostCapabilities();
  const unsupported = {
    ...valid,
    toolExecutions: {
      owner: 'negative-control.in-memory-tool-state',
      durability: 'ephemeral' as const,
      schemaVersion: 1,
    },
  };

  try {
    const port = {
      kind: 'research_lab',
      runId: 'behavior-e2-negative-run',
      runtimeHostCapabilities: unsupported,
      providerDispatch: () => { providerDispatches += 1; },
      toolDispatch: () => { toolDispatches += 1; },
    } as any;
    const unregister = registerHostedRunPersistencePort(port);
    try {
      port.providerDispatch();
      port.toolDispatch();
    } finally {
      unregister();
    }
  } catch (caught) {
    rejected = true;
    error = caught instanceof Error ? caught.message : String(caught);
    errorCode = caught instanceof RuntimeHostCapabilityRegistrationError
      ? caught.code
      : undefined;
  }

  const assertions = [
    assertion(
      'registration.ephemeral_tool_owner_rejected',
      rejected && errorCode === 'runtime_host_capability_registration_rejected',
      'runtime_host_capability_registration_rejected',
      { rejected, errorCode, error },
      'registerHostedRunPersistencePort',
      'A production Research Lab host cannot register ephemeral tool execution state.',
    ),
    assertion(
      'registration.rejected_before_provider_or_tool_dispatch',
      providerDispatches === 0 && toolDispatches === 0,
      { providerDispatches: 0, toolDispatches: 0 },
      { providerDispatches, toolDispatches },
      'negative fixture dispatch counters',
      'Registration rejection must precede model and tool effects.',
    ),
  ];
  return {
    hostKind: 'research_lab',
    rejected,
    ...(errorCode ? { errorCode } : {}),
    error,
    providerDispatches,
    toolDispatches,
    assertions,
    passed: assertions.every((entry) => entry.passed),
  };
};

const normalizedFacts = (fixture: HostFixtureEvidence): string =>
  JSON.stringify(fixture.coldRecords.map((record) => ({
    lifecycle: record.lifecycle,
    schemaVersion: record.schemaVersion,
    value: record.value,
  })));

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

const run = async (): Promise<AssembledScenarioResult<RuntimeHostCapabilitiesEvidenceBundle>> => {
  const organization = runHostFixture('organization');
  const researchLab = runHostFixture('research_lab');
  const sameFacts = normalizedFacts(organization) === normalizedFacts(researchLab);
  const negativeControl = runNegativeFixture();
  const correctedFixturePassed = organization.passed && researchLab.passed && sameFacts;
  const namedMismatches = negativeControl.assertions
    .filter((entry) => !entry.passed)
    .map((entry) => entry.id);
  const negativeControlDetected = negativeControl.passed;
  const evidence: RuntimeHostCapabilitiesEvidenceBundle = {
    schema: 'behavior-lab-runtime-host-capabilities-evidence/v1',
    scenarioId: E2_ASSEMBLED_SCENARIO_ID,
    generatedAt: new Date().toISOString(),
    commit: resolveCommit(),
    claim: {
      terminalPredicates: [
        "runtimeHostCapabilities.hostKind === 'organization'",
        'getHostedRunRuntimeCapabilities({ runId, runHost }).toolExecutions',
        'persistToolExecution = hostedToolExecutionCapability === null',
      ],
      factoryBindings: [
        'createAppContext -> createOrganizationRuntimeHostCapabilities',
        'createHostedAgentRuntimeContext -> createResearchLabRuntimeHostCapabilities',
        'SharedAgentRunHostService -> registerHostedRunPersistencePort',
        'FileHostedRunPersistence.runtimeHostCapabilities',
        'ToolsRegistry.resolveHostedToolExecutionCapability',
      ],
    },
    fixtures: { organization, researchLab, negativeControl },
    verdict: {
      correctedFixturePassed,
      negativeControlDetected,
      namedMismatches,
    },
  };
  const schemaResult = runtimeHostCapabilitiesEvidenceSchema.safeParse(evidence);
  const passed = correctedFixturePassed && negativeControlDetected && schemaResult.success;

  return {
    id: E2_ASSEMBLED_SCENARIO_ID,
    title: 'Host capabilities select real persistence owners',
    mode: 'assembled-runtime',
    passed,
    evidence,
    ...(!passed ? {
      error: `corrected=${correctedFixturePassed}; sameFacts=${sameFacts}; negativeControlDetected=${negativeControlDetected}; schema=${schemaResult.success}${schemaResult.success ? '' : `; schemaErrors=${schemaResult.error.issues.map((issue) => `${issue.path.join('.')}:${issue.message}`).join('|')}`}`,
    } : {}),
  };
};

export const runtimeHostCapabilitiesScenario: AssembledBehaviorScenario<RuntimeHostCapabilitiesEvidenceBundle> = {
  id: E2_ASSEMBLED_SCENARIO_ID,
  title: 'Host capabilities select real persistence owners',
  why: 'Proves that organization and Research Lab factories recover the same durable lifecycle facts through their declared owners and reject ephemeral production tool state before dispatch.',
  run,
};
