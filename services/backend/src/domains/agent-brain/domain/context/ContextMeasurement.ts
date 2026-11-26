import { sha256Hex } from '../workers/sha256';

export const CONTEXT_MEASUREMENT_SCHEMA_VERSION = 1 as const;
export const CONTEXT_COUNTING_METHOD = 'conservative_json_chars_div_4_v1' as const;

export type ContextCapacitySource = 'model_config' | 'provider_capability_fallback';
export type ContextCountingConfidence = 'conservative';

export type ContextComponentCounts = {
  systemTokens: number;
  messageTokens: number;
  toolTokens: number;
  reservedOutputTokens: number;
  providerOverheadTokens: number;
  promptTokens: number;
  totalWithReservedOutputTokens: number;
};

export type ContextThresholds = {
  softRatio: number;
  hardRatio: number;
  softTokens: number;
  hardTokens: number;
};

export type ContextMeasurement = {
  measurementId: string;
  schemaVersion: number;
  requestId: string;
  sessionId: string;
  runId?: string;
  stepId?: string;
  turn: number;
  callOrdinal: number;
  provider: string;
  model: string;
  routedCapacity: number;
  capacitySource: ContextCapacitySource;
  routeFingerprint: string;
  countingMethod: typeof CONTEXT_COUNTING_METHOD;
  countingConfidence: ContextCountingConfidence;
  counts: ContextComponentCounts;
  thresholds: ContextThresholds;
  reducerProfile: string;
  reducerReason: string;
  transformationId?: string;
  createdAt: string;
};

export type ContextMeasurementSnapshot = Pick<
  ContextMeasurement,
  | 'measurementId'
  | 'provider'
  | 'model'
  | 'routedCapacity'
  | 'capacitySource'
  | 'routeFingerprint'
  | 'countingMethod'
  | 'countingConfidence'
  | 'counts'
  | 'thresholds'
  | 'createdAt'
>;

export type ContextMeasurementHints = {
  capacitySource?: ContextCapacitySource;
  reducerProfile?: string;
  reducerReason?: string;
  transformationId?: string;
};

export type BuildContextMeasurementInput = ContextMeasurementHints & {
  measurementId: string;
  requestId: string;
  sessionId: string;
  runId?: string;
  stepId?: string;
  turn: number;
  callOrdinal: number;
  provider: string;
  model: string;
  routedCapacity: number;
  envelope: Record<string, unknown>;
  createdAt?: string;
};

const estimateJsonTokens = (value: unknown): number => {
  const serialized = JSON.stringify(value ?? null);
  return Math.max(0, Math.ceil(serialized.length / 4));
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

export const contextRouteFingerprint = (input: {
  provider: string;
  model: string;
  routedCapacity: number;
  capacitySource: ContextCapacitySource;
}): string => `sha256:${sha256Hex(JSON.stringify([
  input.provider,
  input.model,
  input.routedCapacity,
  input.capacitySource,
]))}`;

export const buildContextMeasurement = (
  input: BuildContextMeasurementInput,
): ContextMeasurement => {
  const messages = Array.isArray(input.envelope.messages)
    ? input.envelope.messages as Array<Record<string, unknown>>
    : [];
  const tools = Array.isArray(input.envelope.tools) ? input.envelope.tools : [];
  const systemMessages = messages.filter((message) => message.role === 'system');
  const nonSystemMessages = messages.filter((message) => message.role !== 'system');
  const systemTokens = estimateJsonTokens(systemMessages);
  const messageTokens = estimateJsonTokens(nonSystemMessages);
  const toolTokens = estimateJsonTokens(tools);
  const reservedOutputTokens = positiveInteger(input.envelope.max_completion_tokens)
    ?? positiveInteger(input.envelope.max_tokens)
    ?? 0;
  // Named conservative allowance for per-message framing, tool framing, and reply priming.
  const providerOverheadTokens = messages.length * 4 + tools.length * 2 + 3;
  const promptTokens = systemTokens + messageTokens + toolTokens + providerOverheadTokens;
  const capacitySource = input.capacitySource ?? 'provider_capability_fallback';
  const routedCapacity = Math.max(1, Math.floor(input.routedCapacity));
  const thresholds: ContextThresholds = {
    softRatio: 0.7,
    hardRatio: 0.9,
    softTokens: Math.floor(routedCapacity * 0.7),
    hardTokens: Math.floor(routedCapacity * 0.9),
  };

  return {
    measurementId: input.measurementId,
    schemaVersion: CONTEXT_MEASUREMENT_SCHEMA_VERSION,
    requestId: input.requestId,
    sessionId: input.sessionId,
    runId: input.runId,
    stepId: input.stepId,
    turn: input.turn,
    callOrdinal: input.callOrdinal,
    provider: input.provider,
    model: input.model,
    routedCapacity,
    capacitySource,
    routeFingerprint: contextRouteFingerprint({
      provider: input.provider,
      model: input.model,
      routedCapacity,
      capacitySource,
    }),
    countingMethod: CONTEXT_COUNTING_METHOD,
    countingConfidence: 'conservative',
    counts: {
      systemTokens,
      messageTokens,
      toolTokens,
      reservedOutputTokens,
      providerOverheadTokens,
      promptTokens,
      totalWithReservedOutputTokens: promptTokens + reservedOutputTokens,
    },
    thresholds,
    reducerProfile: input.reducerProfile ?? 'generic',
    reducerReason: input.reducerReason ?? 'request_measurement',
    transformationId: input.transformationId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
};

export const measurementMatchesRoute = (
  measurement: Pick<
    ContextMeasurement,
    'provider' | 'model' | 'routedCapacity' | 'capacitySource' | 'routeFingerprint'
  >,
  route: {
    provider: string;
    model: string;
    routedCapacity: number;
    capacitySource: ContextCapacitySource;
  },
): boolean => measurement.routeFingerprint === contextRouteFingerprint(route);

export const toContextMeasurementSnapshot = (
  measurement: ContextMeasurement,
): ContextMeasurementSnapshot => ({
  measurementId: measurement.measurementId,
  provider: measurement.provider,
  model: measurement.model,
  routedCapacity: measurement.routedCapacity,
  capacitySource: measurement.capacitySource,
  routeFingerprint: measurement.routeFingerprint,
  countingMethod: measurement.countingMethod,
  countingConfidence: measurement.countingConfidence,
  counts: structuredClone(measurement.counts),
  thresholds: structuredClone(measurement.thresholds),
  createdAt: measurement.createdAt,
});
