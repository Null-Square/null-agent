import type { RuntimeHostCapabilities } from '../../../src/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

export const ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA = 'behavior-lab-assembled-evidence/v1' as const;

export type AssembledFixtureKind = 'corrected' | 'broken-authoritative-omission';

export type VerificationAssertion = {
  id: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  authoritativeSource: string;
  detail: string;
};

export type BehaviorMessageObservation = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  recordedAt: string;
};

export type ModelRequestObservation = {
  requestId: string;
  sessionId: string;
  turn: number;
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string; schema: Record<string, unknown> }>;
  recordedAt: string;
};

export type ProviderAttemptObservation = {
  attemptId: string;
  requestId: string;
  provider: string;
  model: string;
  ordinal: number;
  status: 'completed' | 'failed';
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  recordedAt: string;
};

export type ToolExecutionObservation = {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
};

export type TerminalStateObservation = {
  sessionId: string;
  state: 'interrupted' | 'recovered_unknown' | 'completed' | 'failed';
  reason?: string;
  recordedAt: string;
};

export type HydratedTraceObservation = {
  id: string;
  event: string;
  turn: number;
  severity: string;
  toolCallId?: string;
  payloadMode: 'inline' | 'artifact';
  inlinePayload: unknown;
  hydratedPayload?: unknown;
  artifactPath?: string;
};

export type ArtifactObservation = {
  path: string;
  bytes: number;
  sha256: string;
  compressed: boolean;
  hydratedForEventIds: string[];
};

export type DurableObservationSnapshot = {
  messages: BehaviorMessageObservation[];
  modelRequests: ModelRequestObservation[];
  providerAttempts: ProviderAttemptObservation[];
  toolExecutions: ToolExecutionObservation[];
  terminalStates: TerminalStateObservation[];
  deliberateCorruptions: Array<{
    kind: 'omit_tool_execution_records';
    toolCallId: string;
    reason: string;
    recordedAt: string;
  }>;
};

export type AssembledFixtureEvidence = {
  fixture: AssembledFixtureKind;
  legacyFirstToolAssertionPassed: boolean;
  newGatePassed: boolean;
  namedFaultPoint: string;
  coldRestartPerformed: boolean;
  firstRunError?: string;
  recoveryRunError?: string;
  authoritativeBeforeRestart: ToolExecutionObservation[];
  authoritativeAtColdStart: ToolExecutionObservation[];
  durable: DurableObservationSnapshot;
  trace: HydratedTraceObservation[];
  artifacts: ArtifactObservation[];
  externalState: {
    count: number;
    effects: Array<{
      toolCallId: string;
      recordedAt: string;
    }>;
  };
  assertions: VerificationAssertion[];
};

export type AssembledBehaviorEvidenceBundle = {
  schema: typeof ASSEMBLED_BEHAVIOR_EVIDENCE_SCHEMA;
  scenarioId: string;
  generatedAt: string;
  commit: string;
  claim: {
    text: string;
    affectedRuntimeSurfaces: string[];
    terminalExpressions: string[];
    authoritativeRecords: string[];
    weakerProjections: string[];
  };
  configuration: {
    deterministicProvider: boolean;
    liveCanaryRequired: boolean;
    artifactInlineLimit: number;
    faultPoint: string;
    toolCallId: string;
  };
  host: {
    kind: 'behavior_lab_assembled';
    capabilities: RuntimeHostCapabilities;
    factoryBindings: string[];
  };
  fixtures: {
    corrected: AssembledFixtureEvidence;
    negativeControl: AssembledFixtureEvidence;
  };
  verdict: {
    correctedFixturePassed: boolean;
    negativeControlDetected: boolean;
    legacyAssertionPassedOnBrokenFixture: boolean;
    namedMismatches: string[];
  };
};

export type AssembledEvidenceVerdict = {
  correctedFixturePassed: boolean;
  negativeControlDetected: boolean;
  namedMismatches: string[];
};

export type AssembledScenarioEvidence = {
  verdict: AssembledEvidenceVerdict;
};

export type AssembledScenarioResult<
  TEvidence extends AssembledScenarioEvidence = AssembledScenarioEvidence,
> = {
  id: string;
  title: string;
  mode: 'assembled-runtime';
  passed: boolean;
  evidence: TEvidence;
  error?: string;
};

export type AssembledBehaviorScenario<
  TEvidence extends AssembledScenarioEvidence = AssembledScenarioEvidence,
> = {
  id: string;
  title: string;
  why: string;
  run: () => Promise<AssembledScenarioResult<TEvidence>>;
};
