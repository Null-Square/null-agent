import type OpenAI from 'openai';
import type { ContextMeasurement } from '../domain/context';

export const MODEL_REQUEST_SCHEMA_VERSION = 2 as const;
export const CONTEXTUAL_MODEL_REQUEST_SCHEMA_VERSION = 3 as const;

export type ModelRequestProvenance = 'recorded' | 'reconstructed_legacy';

export interface ModelRequestRecord {
  requestId: string;
  schemaVersion: number;
  provenance: ModelRequestProvenance;
  sessionId: string;
  runId?: string;
  stepId?: string;
  turn: number;
  callOrdinal: number;
  routeReason: string;
  provider: string;
  model: string;
  routedContextCapacity: number;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  systemContent: unknown[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  toolChoice?: unknown;
  generationSettings: Record<string, unknown>;
  contextMeasurementRefs: string[];
  transformationRefs: string[];
  contextMeasurement?: ContextMeasurement;
  envelope: Record<string, unknown>;
  digest: string;
  createdAt: Date;
}

export type AppendModelRequestInput = Omit<
  ModelRequestRecord,
  'provenance' | 'createdAt'
> & {
  createdAt?: Date;
};

export interface ModelRequestPort {
  /** Append one immutable logical request before its first provider attempt. */
  append(input: AppendModelRequestInput): Promise<ModelRequestRecord>;
  findByRequestId(requestId: string): Promise<ModelRequestRecord | undefined>;
  findBySession(sessionId: string): Promise<ModelRequestRecord[]>;
}

export const supportsAtomicModelRequests = (
  port: ModelRequestPort | undefined,
): port is ModelRequestPort => Boolean(
  port
  && typeof port.append === 'function'
  && typeof port.findByRequestId === 'function'
  && typeof port.findBySession === 'function',
);

export const reconstructLegacyModelRequest = (
  input: Omit<ModelRequestRecord, 'provenance'>,
): ModelRequestRecord => ({
  ...input,
  provenance: 'reconstructed_legacy',
});
