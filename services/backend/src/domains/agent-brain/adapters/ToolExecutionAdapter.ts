/**
 * Drizzle implementation of the authoritative tool-execution lifecycle.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { toolExecutionRecords } from '@/db/schema';
import type { DatabaseClient } from '@/db/client';
import {
  normalizeToolExecutionStatus,
  type BlockToolExecutionInput,
  type CanonicalToolExecutionStatus,
  type CompleteToolExecutionInput,
  type CreateToolExecutionInput,
  type FailToolExecutionInput,
  type OutcomeUnknownToolExecutionInput,
  type ToolExecutionIdentity,
  type ToolExecutionPort,
  type ToolExecutionRecord,
} from '../ports';

const NULL_CHAR = String.fromCharCode(0);
const MAX_JSONB_DEPTH = 12;

const sanitizeJsonbValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'string') return value.split(NULL_CHAR).join('');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_JSONB_DEPTH) return '[Object omitted: max depth reached]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonbValue(item, depth + 1, seen));
    }
    const next: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      next[key] = sanitizeJsonbValue(entryValue, depth + 1, seen);
    }
    return next;
  } finally {
    seen.delete(value);
  }
};

const sanitizeJsonbRecord = (
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined =>
  value ? sanitizeJsonbValue(value) as Record<string, unknown> : undefined;

export class ToolExecutionTransitionError extends Error {
  readonly code = 'tool_execution_transition_rejected';

  constructor(input: {
    sessionId: string;
    toolCallId: string;
    expected: readonly CanonicalToolExecutionStatus[];
    actual: string;
    target: CanonicalToolExecutionStatus;
  }) {
    super(
      `Tool execution transition rejected: session=${input.sessionId} toolCallId=${input.toolCallId} expected=${input.expected.join('|')} actual=${input.actual} target=${input.target}`,
    );
    this.name = 'ToolExecutionTransitionError';
  }
}

export class ToolExecutionAdapter implements ToolExecutionPort {
  constructor(private readonly db: DatabaseClient) {}

  async findByToolCallId(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolExecutionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(toolExecutionRecords)
      .where(and(
        eq(toolExecutionRecords.sessionId, sessionId),
        eq(toolExecutionRecords.toolCallId, toolCallId),
      ))
      .limit(1);
    return rows[0] ? this.mapRow(rows[0]) : undefined;
  }

  async create(input: CreateToolExecutionInput): Promise<ToolExecutionRecord> {
    return (await this.claim(input)).record;
  }

  async claim(
    input: CreateToolExecutionInput,
  ): Promise<{ record: ToolExecutionRecord; claimed: boolean }> {
    const [inserted] = await this.db
      .insert(toolExecutionRecords)
      .values({
        sessionId: input.sessionId,
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        modelRequestId: input.modelRequestId,
        args: sanitizeJsonbRecord(input.args),
        status: 'claimed',
      })
      .onConflictDoNothing({
        target: [toolExecutionRecords.sessionId, toolExecutionRecords.toolCallId],
      })
      .returning();
    if (inserted) return { record: this.mapRow(inserted), claimed: true };
    const existing = await this.findByToolCallId(input.sessionId, input.toolCallId);
    if (!existing) throw new Error('tool_execution_claim_conflict_without_record');
    return { record: existing, claimed: false };
  }

  async markStarted(input: ToolExecutionIdentity): Promise<void> {
    await this.transition(input, {
      allowed: ['claimed'],
      target: 'started',
      values: { status: 'started', startedAt: new Date() },
    });
  }

  async complete(input: CompleteToolExecutionInput): Promise<void> {
    await this.transition(input, {
      allowed: ['started'],
      target: 'succeeded',
      values: {
        status: 'succeeded',
        result: sanitizeJsonbValue(input.result),
        completedAt: new Date(),
        durationMs: input.durationMs,
      },
    });
  }

  async fail(input: FailToolExecutionInput): Promise<void> {
    await this.transition(input, {
      allowed: ['started'],
      target: 'failed',
      values: {
        status: 'failed',
        error: input.error.split(NULL_CHAR).join(''),
        completedAt: new Date(),
        durationMs: input.durationMs,
      },
    });
  }

  async block(input: BlockToolExecutionInput): Promise<void> {
    await this.transition(input, {
      allowed: ['claimed', 'started'],
      target: 'blocked',
      values: {
        status: 'blocked',
        error: input.reason.split(NULL_CHAR).join(''),
        completedAt: new Date(),
        durationMs: input.durationMs,
      },
    });
  }

  async markOutcomeUnknown(input: OutcomeUnknownToolExecutionInput): Promise<void> {
    await this.transition(input, {
      allowed: ['started'],
      target: 'outcome_unknown',
      values: {
        status: 'outcome_unknown',
        error: input.reason.split(NULL_CHAR).join(''),
        completedAt: new Date(),
      },
    });
  }

  async findBySession(sessionId: string): Promise<ToolExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(toolExecutionRecords)
      .where(eq(toolExecutionRecords.sessionId, sessionId))
      .orderBy(toolExecutionRecords.claimedAt);
    return rows.map((row) => this.mapRow(row));
  }

  async findByTurn(sessionId: string, turnId: string): Promise<ToolExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(toolExecutionRecords)
      .where(and(
        eq(toolExecutionRecords.sessionId, sessionId),
        eq(toolExecutionRecords.turnId, turnId),
      ))
      .orderBy(toolExecutionRecords.claimedAt);
    return rows.map((row) => this.mapRow(row));
  }

  private async transition(
    input: ToolExecutionIdentity,
    transition: {
      allowed: CanonicalToolExecutionStatus[];
      target: CanonicalToolExecutionStatus;
      values: Partial<typeof toolExecutionRecords.$inferInsert>;
    },
  ): Promise<void> {
    const [updated] = await this.db
      .update(toolExecutionRecords)
      .set(transition.values)
      .where(and(
        eq(toolExecutionRecords.sessionId, input.sessionId),
        eq(toolExecutionRecords.toolCallId, input.toolCallId),
        inArray(toolExecutionRecords.status, transition.allowed),
      ))
      .returning();
    if (updated) return;

    const existing = await this.findByToolCallId(input.sessionId, input.toolCallId);
    const actual = existing ? normalizeToolExecutionStatus(existing) : 'missing';
    if (actual === transition.target) return;
    throw new ToolExecutionTransitionError({
      ...input,
      expected: transition.allowed,
      actual,
      target: transition.target,
    });
  }

  private mapRow(row: typeof toolExecutionRecords.$inferSelect): ToolExecutionRecord {
    const legacy = {
      status: row.status as ToolExecutionRecord['status'],
      claimedAt: row.claimedAt ?? undefined,
      startedAt: row.startedAt ?? undefined,
    };
    return {
      id: row.id,
      sessionId: row.sessionId,
      turnId: row.turnId,
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      modelRequestId: row.modelRequestId ?? undefined,
      args: row.args ?? undefined,
      result: row.result ?? undefined,
      status: normalizeToolExecutionStatus(legacy),
      claimedAt: row.claimedAt ?? row.startedAt ?? undefined,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      durationMs: row.durationMs ?? undefined,
      error: row.error ?? undefined,
    };
  }
}
