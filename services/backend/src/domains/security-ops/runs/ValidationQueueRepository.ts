import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  runValidationQueue,
  type NewRunValidationQueueRow,
  type RunValidationQueueRow,
} from '@/db/schema';

export type ValidationQueueStatus =
  | 'queued'
  | 'in_progress'
  | 'validated'
  | 'false_positive'
  | 'inconclusive'
  | 'failed'
  | 'cancelled';

export type ValidationQueueOutcome = 'validated' | 'false_positive' | 'inconclusive';

const OPEN_STATUSES: ValidationQueueStatus[] = ['queued', 'in_progress'];

export class ValidationQueueRepository {
  constructor(private readonly db: DatabaseClient) {}

  async enqueue(params: {
    runId: string;
    findingId: string;
    phaseId?: string | null;
    rationale?: string | null;
    requestedBySessionId?: string | null;
  }): Promise<RunValidationQueueRow> {
    const now = new Date();
    const values: NewRunValidationQueueRow = {
      runId: params.runId,
      findingId: params.findingId,
      phaseId: params.phaseId ?? null,
      status: 'queued',
      rationale: params.rationale?.trim() || null,
      requestedBySessionId: params.requestedBySessionId ?? null,
      updatedAt: now,
    };

    const [row] = await this.db
      .insert(runValidationQueue)
      .values(values)
      .onConflictDoUpdate({
        target: [runValidationQueue.runId, runValidationQueue.findingId],
        set: {
          status: 'queued',
          phaseId: params.phaseId ?? null,
          rationale: params.rationale?.trim() || null,
          requestedBySessionId: params.requestedBySessionId ?? null,
          updatedAt: now,
        },
      })
      .returning();

    return row;
  }

  async listOpenByRunId(runId: string): Promise<RunValidationQueueRow[]> {
    const rows = await this.db
      .select()
      .from(runValidationQueue)
      .where(and(eq(runValidationQueue.runId, runId), inArray(runValidationQueue.status, OPEN_STATUSES)));

    return Array.isArray(rows) ? rows : [];
  }

  async listByRunId(runId: string): Promise<RunValidationQueueRow[]> {
    const rows = await this.db
      .select()
      .from(runValidationQueue)
      .where(eq(runValidationQueue.runId, runId));

    return Array.isArray(rows) ? rows : [];
  }

  async listForPhase(phaseId: string): Promise<RunValidationQueueRow[]> {
    const rows = await this.db
      .select()
      .from(runValidationQueue)
      .where(
        and(
          eq(runValidationQueue.phaseId, phaseId),
          inArray(runValidationQueue.status, OPEN_STATUSES),
        ),
      );

    return Array.isArray(rows) ? rows : [];
  }

  async attachOpenQueueToPhase(params: {
    runId: string;
    phaseId: string;
    sessionId: string;
  }): Promise<RunValidationQueueRow[]> {
    const now = new Date();
    const rows = await this.db
      .update(runValidationQueue)
      .set({
        phaseId: params.phaseId,
        validatorSessionId: params.sessionId,
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runValidationQueue.runId, params.runId),
          or(isNull(runValidationQueue.phaseId), eq(runValidationQueue.phaseId, params.phaseId)),
          inArray(runValidationQueue.status, OPEN_STATUSES),
        ),
      )
      .returning();

    return Array.isArray(rows) ? rows : [];
  }

  async completeFinding(params: {
    runId: string;
    findingId: string;
    outcome: ValidationQueueOutcome;
    sessionId?: string | null;
    resultRef?: string | null;
  }): Promise<RunValidationQueueRow | null> {
    const now = new Date();
    const [row] = await this.db
      .update(runValidationQueue)
      .set({
        status: params.outcome,
        outcome: params.outcome,
        validatorSessionId: params.sessionId ?? null,
        resultRef: params.resultRef ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(runValidationQueue.runId, params.runId), eq(runValidationQueue.findingId, params.findingId)))
      .returning();

    return row ?? null;
  }
}
