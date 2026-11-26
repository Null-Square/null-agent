import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { historyTransformationRecords } from '@/db/schema';
import {
  HistoryTransformationImmutableConflictError,
  type HistoryTransformationPort,
  type HistoryTransformationRecord,
  type HistoryTransformationStatus,
  type PersistHistoryReplacementInput,
  type PrepareHistoryTransformationInput,
} from '../ports';

const sameReplacement = (
  record: HistoryTransformationRecord,
  input: PersistHistoryReplacementInput,
): boolean => record.replacementSummary === input.replacementSummary
  && record.replacementMessageId === input.replacementMessageId
  && JSON.stringify(record.afterMeasurement) === JSON.stringify(input.afterMeasurement);

export class HistoryTransformationAdapter implements HistoryTransformationPort {
  constructor(private readonly db: DatabaseClient) {}

  async prepare(input: PrepareHistoryTransformationInput): Promise<HistoryTransformationRecord> {
    const [inserted] = await this.db
      .insert(historyTransformationRecords)
      .values({
        transactionId: input.transactionId,
        schemaVersion: input.schemaVersion,
        sessionId: input.sessionId,
        runId: input.runId,
        stepId: input.stepId,
        turn: input.turn,
        status: 'prepared',
        reducerProfile: input.reducerProfile,
        reason: input.reason,
        intent: input.intent,
        inputHistoryVersion: input.inputHistoryVersion,
        outputHistoryVersion: input.outputHistoryVersion,
        inputMessageIds: [...input.inputMessageIds],
        inputStartMessageId: input.inputStartMessageId,
        inputEndMessageId: input.inputEndMessageId,
        inputDigest: input.inputDigest,
        configurationDigest: input.configurationDigest,
        beforeMeasurement: structuredClone(input.beforeMeasurement),
        triggerRequestId: input.triggerRequestId,
        createdAt: input.createdAt ? new Date(input.createdAt) : undefined,
      })
      .onConflictDoNothing({ target: historyTransformationRecords.transactionId })
      .returning();
    if (inserted) return this.mapRow(inserted);
    const existing = await this.findById(input.transactionId);
    if (
      !existing
      || existing.sessionId !== input.sessionId
      || existing.inputDigest !== input.inputDigest
      || existing.configurationDigest !== input.configurationDigest
      || existing.inputHistoryVersion !== input.inputHistoryVersion
      || JSON.stringify(existing.inputMessageIds) !== JSON.stringify(input.inputMessageIds)
    ) {
      throw new HistoryTransformationImmutableConflictError(input.transactionId);
    }
    return existing;
  }

  async persistReplacement(
    transactionId: string,
    input: PersistHistoryReplacementInput,
  ): Promise<HistoryTransformationRecord> {
    const existing = await this.findById(transactionId);
    if (!existing) throw new Error(`history_transformation_not_found:${transactionId}`);
    if (existing.status !== 'prepared') {
      if (sameReplacement(existing, input)) return existing;
      throw new HistoryTransformationImmutableConflictError(transactionId);
    }
    const [updated] = await this.db
      .update(historyTransformationRecords)
      .set({
        status: 'replacement_persisted',
        replacementSummary: input.replacementSummary,
        replacementMessageId: input.replacementMessageId,
        afterMeasurement: structuredClone(input.afterMeasurement),
        replacementPersistedAt: input.replacementPersistedAt
          ? new Date(input.replacementPersistedAt)
          : new Date(),
      })
      .where(and(
        eq(historyTransformationRecords.transactionId, transactionId),
        eq(historyTransformationRecords.status, 'prepared'),
      ))
      .returning();
    if (updated) return this.mapRow(updated);
    const raced = await this.findById(transactionId);
    if (raced && sameReplacement(raced, input)) return raced;
    throw new HistoryTransformationImmutableConflictError(transactionId);
  }

  async activate(transactionId: string, activatedAt?: string): Promise<HistoryTransformationRecord> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(historyTransformationRecords)
        .where(eq(historyTransformationRecords.transactionId, transactionId))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error(`history_transformation_not_found:${transactionId}`);
      if (row.status === 'activated') return this.mapRow(row);
      if (
        row.status !== 'replacement_persisted'
        || !row.replacementSummary
        || !row.replacementMessageId
        || !row.afterMeasurement
      ) {
        throw new Error(`history_transformation_not_ready:${transactionId}:${row.status}`);
      }
      await tx
        .update(historyTransformationRecords)
        .set({ status: 'superseded' })
        .where(and(
          eq(historyTransformationRecords.sessionId, row.sessionId),
          eq(historyTransformationRecords.status, 'activated'),
        ));
      const [activated] = await tx
        .update(historyTransformationRecords)
        .set({
          status: 'activated',
          activatedAt: activatedAt ? new Date(activatedAt) : new Date(),
        })
        .where(and(
          eq(historyTransformationRecords.transactionId, transactionId),
          eq(historyTransformationRecords.status, 'replacement_persisted'),
        ))
        .returning();
      if (!activated) throw new HistoryTransformationImmutableConflictError(transactionId);
      return this.mapRow(activated);
    });
  }

  async findById(transactionId: string): Promise<HistoryTransformationRecord | undefined> {
    const rows = await this.db
      .select()
      .from(historyTransformationRecords)
      .where(eq(historyTransformationRecords.transactionId, transactionId))
      .limit(1);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async findActiveBySession(sessionId: string): Promise<HistoryTransformationRecord | undefined> {
    const rows = await this.db
      .select()
      .from(historyTransformationRecords)
      .where(and(
        eq(historyTransformationRecords.sessionId, sessionId),
        eq(historyTransformationRecords.status, 'activated'),
      ))
      .orderBy(historyTransformationRecords.outputHistoryVersion)
      .limit(1);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async findBySession(sessionId: string): Promise<HistoryTransformationRecord[]> {
    const rows = await this.db
      .select()
      .from(historyTransformationRecords)
      .where(eq(historyTransformationRecords.sessionId, sessionId))
      .orderBy(historyTransformationRecords.outputHistoryVersion);
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: typeof historyTransformationRecords.$inferSelect): HistoryTransformationRecord {
    return {
      transactionId: row.transactionId,
      schemaVersion: row.schemaVersion,
      provenance: 'recorded',
      sessionId: row.sessionId,
      runId: row.runId ?? undefined,
      stepId: row.stepId ?? undefined,
      turn: row.turn,
      status: row.status as HistoryTransformationStatus,
      reducerProfile: row.reducerProfile,
      reason: row.reason as HistoryTransformationRecord['reason'],
      intent: row.intent,
      inputHistoryVersion: row.inputHistoryVersion,
      outputHistoryVersion: row.outputHistoryVersion,
      inputMessageIds: row.inputMessageIds,
      inputStartMessageId: row.inputStartMessageId,
      inputEndMessageId: row.inputEndMessageId,
      inputDigest: row.inputDigest,
      configurationDigest: row.configurationDigest,
      beforeMeasurement: row.beforeMeasurement,
      replacementSummary: row.replacementSummary ?? undefined,
      replacementMessageId: row.replacementMessageId ?? undefined,
      afterMeasurement: row.afterMeasurement ?? undefined,
      triggerRequestId: row.triggerRequestId ?? undefined,
      createdAt: row.createdAt.toISOString(),
      replacementPersistedAt: row.replacementPersistedAt?.toISOString(),
      activatedAt: row.activatedAt?.toISOString(),
    };
  }
}
