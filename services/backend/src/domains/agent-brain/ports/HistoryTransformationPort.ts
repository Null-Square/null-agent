import type { ContextMeasurementSnapshot } from '../domain/context';
import { sha256Hex } from '../domain/workers/sha256';

export const HISTORY_TRANSFORMATION_SCHEMA_VERSION = 1 as const;

export type HistoryTransformationStatus =
  | 'prepared'
  | 'replacement_persisted'
  | 'activated'
  | 'superseded';

export type HistoryTransformationProvenance = 'recorded' | 'reconstructed_legacy';

export type HistoryTransformationRecord = {
  transactionId: string;
  schemaVersion: number;
  provenance: HistoryTransformationProvenance;
  sessionId: string;
  runId?: string;
  stepId?: string;
  turn: number;
  status: HistoryTransformationStatus;
  reducerProfile: string;
  reason: 'soft_threshold' | 'provider_context_overflow' | 'legacy_reconstruction';
  intent: string;
  inputHistoryVersion: number;
  outputHistoryVersion: number;
  inputMessageIds: string[];
  inputStartMessageId: string;
  inputEndMessageId: string;
  inputDigest: string;
  configurationDigest: string;
  beforeMeasurement: ContextMeasurementSnapshot;
  replacementSummary?: string;
  replacementMessageId?: string;
  afterMeasurement?: ContextMeasurementSnapshot;
  triggerRequestId?: string;
  createdAt: string;
  replacementPersistedAt?: string;
  activatedAt?: string;
};

export type PrepareHistoryTransformationInput = Omit<
  HistoryTransformationRecord,
  | 'provenance'
  | 'status'
  | 'replacementSummary'
  | 'replacementMessageId'
  | 'afterMeasurement'
  | 'replacementPersistedAt'
  | 'activatedAt'
  | 'createdAt'
> & {
  createdAt?: string;
};

export type PersistHistoryReplacementInput = {
  replacementSummary: string;
  replacementMessageId: string;
  afterMeasurement: ContextMeasurementSnapshot;
  replacementPersistedAt?: string;
};

export interface HistoryTransformationPort {
  prepare(input: PrepareHistoryTransformationInput): Promise<HistoryTransformationRecord>;
  persistReplacement(
    transactionId: string,
    input: PersistHistoryReplacementInput,
  ): Promise<HistoryTransformationRecord>;
  activate(transactionId: string, activatedAt?: string): Promise<HistoryTransformationRecord>;
  findById(transactionId: string): Promise<HistoryTransformationRecord | undefined>;
  findActiveBySession(sessionId: string): Promise<HistoryTransformationRecord | undefined>;
  findBySession(sessionId: string): Promise<HistoryTransformationRecord[]>;
}

export class HistoryTransformationImmutableConflictError extends Error {
  readonly code = 'history_transformation_immutable_conflict';

  constructor(transactionId: string) {
    super(`History transformation ${transactionId} conflicts with the durable transaction`);
    this.name = 'HistoryTransformationImmutableConflictError';
  }
}

export const supportsTransactionalHistory = (
  port: HistoryTransformationPort | undefined,
): port is HistoryTransformationPort => Boolean(
  port
  && typeof port.prepare === 'function'
  && typeof port.persistReplacement === 'function'
  && typeof port.activate === 'function'
  && typeof port.findById === 'function'
  && typeof port.findActiveBySession === 'function'
  && typeof port.findBySession === 'function',
);

export const createHistoryTransformationId = (input: {
  sessionId: string;
  inputHistoryVersion: number;
  inputMessageIds: string[];
  reducerProfile: string;
  reason: string;
  configurationDigest: string;
}): string => `history:${sha256Hex(JSON.stringify([
  input.sessionId,
  input.inputHistoryVersion,
  input.inputMessageIds,
  input.reducerProfile,
  input.reason,
  input.configurationDigest,
]))}`;

export const reconstructLegacyHistoryTransformation = (input: {
  sessionId: string;
  turn: number;
  summary: string;
  cutoffMessageId: string;
  inputMessageIds: string[];
  version: number;
  measurement: ContextMeasurementSnapshot;
}): HistoryTransformationRecord => {
  const configurationDigest = `sha256:${sha256Hex('legacy_compaction_record')}`;
  const transactionId = createHistoryTransformationId({
    sessionId: input.sessionId,
    inputHistoryVersion: Math.max(0, input.version - 1),
    inputMessageIds: input.inputMessageIds,
    reducerProfile: 'legacy',
    reason: 'legacy_reconstruction',
    configurationDigest,
  });
  return {
    transactionId,
    schemaVersion: 0,
    provenance: 'reconstructed_legacy',
    sessionId: input.sessionId,
    turn: input.turn,
    status: 'activated',
    reducerProfile: 'legacy',
    reason: 'legacy_reconstruction',
    intent: 'Read compatibility for the pre-transactional compaction fields.',
    inputHistoryVersion: Math.max(0, input.version - 1),
    outputHistoryVersion: input.version,
    inputMessageIds: [...input.inputMessageIds],
    inputStartMessageId: input.inputMessageIds[0] ?? input.cutoffMessageId,
    inputEndMessageId: input.cutoffMessageId,
    inputDigest: `sha256:${sha256Hex(JSON.stringify(input.inputMessageIds))}`,
    configurationDigest,
    beforeMeasurement: structuredClone(input.measurement),
    replacementSummary: input.summary,
    replacementMessageId: `legacy-compaction-summary:${input.sessionId}:${input.version}`,
    afterMeasurement: structuredClone(input.measurement),
    createdAt: input.measurement.createdAt,
    replacementPersistedAt: input.measurement.createdAt,
    activatedAt: input.measurement.createdAt,
  };
};
