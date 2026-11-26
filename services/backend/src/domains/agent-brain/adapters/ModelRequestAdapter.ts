import { eq } from 'drizzle-orm';
import type OpenAI from 'openai';

import type { DatabaseClient } from '@/db/client';
import { modelRequestRecords } from '@/db/schema';
import type {
  AppendModelRequestInput,
  ModelRequestPort,
  ModelRequestRecord,
} from '../ports';

export class ModelRequestImmutableConflictError extends Error {
  readonly code = 'model_request_immutable_conflict';

  constructor(requestId: string) {
    super(`Model request ${requestId} already exists with different canonical content`);
    this.name = 'ModelRequestImmutableConflictError';
  }
}

export class ModelRequestAdapter implements ModelRequestPort {
  constructor(private readonly db: DatabaseClient) {}

  async append(input: AppendModelRequestInput): Promise<ModelRequestRecord> {
    const [inserted] = await this.db
      .insert(modelRequestRecords)
      .values({
        requestId: input.requestId,
        schemaVersion: input.schemaVersion,
        sessionId: input.sessionId,
        runId: input.runId,
        stepId: input.stepId,
        turn: input.turn,
        callOrdinal: input.callOrdinal,
        routeReason: input.routeReason,
        provider: input.provider,
        model: input.model,
        routedContextCapacity: input.routedContextCapacity,
        messages: structuredClone(input.messages),
        systemContent: structuredClone(input.systemContent),
        tools: structuredClone(input.tools),
        toolChoice: input.toolChoice === undefined ? undefined : structuredClone(input.toolChoice),
        generationSettings: structuredClone(input.generationSettings),
        contextMeasurementRefs: [...input.contextMeasurementRefs],
        transformationRefs: [...input.transformationRefs],
        contextMeasurement: input.contextMeasurement
          ? structuredClone(input.contextMeasurement)
          : undefined,
        envelope: structuredClone(input.envelope),
        digest: input.digest,
        createdAt: input.createdAt,
      })
      .onConflictDoNothing({ target: modelRequestRecords.requestId })
      .returning();
    if (inserted) return this.mapRow(inserted);
    const existing = await this.findByRequestId(input.requestId);
    if (!existing) throw new Error('model_request_append_conflict_without_record');
    if (existing.digest !== input.digest) {
      throw new ModelRequestImmutableConflictError(input.requestId);
    }
    return existing;
  }

  async findByRequestId(requestId: string): Promise<ModelRequestRecord | undefined> {
    const rows = await this.db
      .select()
      .from(modelRequestRecords)
      .where(eq(modelRequestRecords.requestId, requestId))
      .limit(1);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async findBySession(sessionId: string): Promise<ModelRequestRecord[]> {
    const rows = await this.db
      .select()
      .from(modelRequestRecords)
      .where(eq(modelRequestRecords.sessionId, sessionId))
      .orderBy(modelRequestRecords.createdAt);
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: typeof modelRequestRecords.$inferSelect): ModelRequestRecord {
    return {
      requestId: row.requestId,
      schemaVersion: row.schemaVersion,
      provenance: 'recorded',
      sessionId: row.sessionId,
      runId: row.runId ?? undefined,
      stepId: row.stepId ?? undefined,
      turn: row.turn,
      callOrdinal: row.callOrdinal,
      routeReason: row.routeReason,
      provider: row.provider,
      model: row.model,
      routedContextCapacity: row.routedContextCapacity,
      messages: row.messages as OpenAI.Chat.ChatCompletionMessageParam[],
      systemContent: row.systemContent,
      tools: row.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
      toolChoice: row.toolChoice ?? undefined,
      generationSettings: row.generationSettings,
      contextMeasurementRefs: row.contextMeasurementRefs,
      transformationRefs: row.transformationRefs,
      contextMeasurement: row.contextMeasurement ?? undefined,
      envelope: row.envelope,
      digest: row.digest,
      createdAt: row.createdAt,
    };
  }
}
