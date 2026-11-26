import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import { db, type DatabaseClient } from '@/db/client';
import { agentMessages, agentSessionEvents, agentSessions } from '@/db/schema';
import {
  SessionJournalConflictError,
  SessionJournalIdempotencyError,
  type AppendSessionEventsInput,
  type SessionEventJournalPort,
} from '../../ports';
import {
  foldSessionJournal,
  SESSION_EVENT_SCHEMA_VERSION,
  type SessionEventRecord,
} from '../../domain/session-journal';
import type { Message } from '../../domain/types';

type TranscriptProjectionTransaction = Pick<DatabaseClient, 'select' | 'insert' | 'delete'>;

export class SessionEventJournalRepository implements SessionEventJournalPort {
  constructor(private readonly database: DatabaseClient = db) {}

  async append(input: AppendSessionEventsInput): Promise<SessionEventRecord[]> {
    if (input.events.length === 0) return [];
    const eventIds = input.events.map((event) => event.eventId);
    if (new Set(eventIds).size !== eventIds.length) {
      const duplicate = eventIds.find((eventId, index) => eventIds.indexOf(eventId) !== index);
      throw new SessionJournalIdempotencyError(duplicate ?? 'unknown', 'the append batch repeats an event ID');
    }
    for (const event of input.events) {
      const schemaVersion = event.schemaVersion ?? SESSION_EVENT_SCHEMA_VERSION;
      if (schemaVersion !== SESSION_EVENT_SCHEMA_VERSION) {
        throw new Error(`Unsupported session journal schema version ${schemaVersion}.`);
      }
    }

    return this.database.transaction(async (tx) => {
      const [session] = await tx
        .select({ id: agentSessions.id })
        .from(agentSessions)
        .where(eq(agentSessions.id, input.sessionId))
        .limit(1)
        .for('update');
      if (!session) {
        throw new Error(`Cannot append journal events: session ${input.sessionId} does not exist.`);
      }

      // A caller may lose the commit acknowledgement and retry the same batch.
      // Event identity makes that retry a read, not a second append.
      const replayRows = await tx
        .select()
        .from(agentSessionEvents)
        .where(inArray(agentSessionEvents.eventId, eventIds));
      if (replayRows.length > 0) {
        const byId = new Map(replayRows.map((row) => [row.eventId, row]));
        const firstSequence = byId.get(input.events[0]!.eventId)?.sequence;
        for (const [index, event] of input.events.entries()) {
          const row = byId.get(event.eventId);
          if (!row) {
            throw new SessionJournalIdempotencyError(
              event.eventId,
              'only part of the atomic append batch already exists',
            );
          }
          const normalizedPayload = JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>;
          const schemaVersion = event.schemaVersion ?? SESSION_EVENT_SCHEMA_VERSION;
          if (row.sessionId !== input.sessionId
            // A lost-acknowledgement retry normally observes the committed
            // batch at the current tail, so its freshly-read expectedSequence
            // is no longer the sequence from the original attempt. Validate
            // the stored batch's own contiguity instead.
            || firstSequence === undefined
            || row.sequence !== firstSequence + index
            || row.eventType !== event.eventType
            || row.schemaVersion !== schemaVersion
            || row.causationEventId !== (event.causationEventId ?? null)
            || row.correlationId !== (event.correlationId ?? null)
            || !isDeepStrictEqual(row.payload, normalizedPayload)) {
            throw new SessionJournalIdempotencyError(
              event.eventId,
              'the stored event does not match the retried event',
            );
          }
        }
        // The original append and coordination projection committed together.
        // Replaying an acknowledged event must therefore be read-only: a later
        // Stop/Start event may already have superseded this projection.
        return input.events.map((event) => this.toDomain(byId.get(event.eventId)!));
      }

      const [tail] = await tx
        .select({ sequence: max(agentSessionEvents.sequence) })
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, input.sessionId));
      const actualSequence = Number(tail?.sequence ?? 0);
      if (actualSequence !== input.expectedSequence) {
        throw new SessionJournalConflictError(
          input.sessionId,
          input.expectedSequence,
          actualSequence,
        );
      }

      const values = input.events.map((event, index) => ({
        eventId: event.eventId,
        sessionId: input.sessionId,
        sequence: actualSequence + index + 1,
        eventType: event.eventType,
        schemaVersion: event.schemaVersion ?? SESSION_EVENT_SCHEMA_VERSION,
        payload: event.payload as Record<string, unknown>,
        causationEventId: event.causationEventId ?? null,
        correlationId: event.correlationId ?? null,
        createdAt: event.createdAt ?? new Date(),
      }));
      const rows = await tx.insert(agentSessionEvents).values(values).returning();
      await this.projectTranscript(tx, input.sessionId, input.events);
      if (input.coordination) {
        const completionProjection = input.coordination.completeSession
          ? {
              completed: true,
              blockedReason: null,
              metadata: sql`(COALESCE(${agentSessions.metadata}, '{}'::jsonb) #- '{flags,session,completed}') - 'blockedMeta'`,
            }
          : input.coordination.reopenSession
            ? {
                completed: false,
                metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) #- '{flags,session,completed}'`,
              }
            : {};
        const blockedProjection = input.coordination.blockedReason === undefined
          ? {}
          : input.coordination.blockedReason === null
            ? {
                blockedReason: null,
                metadata: input.coordination.reopenSession
                  ? sql`(COALESCE(${agentSessions.metadata}, '{}'::jsonb) #- '{flags,session,completed}') - 'blockedMeta'`
                  : sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta'`,
              }
            : {
                blockedReason: input.coordination.blockedReason,
                metadata: input.coordination.blockedMeta
                  ? sql`(COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta') || ${JSON.stringify({ blockedMeta: input.coordination.blockedMeta })}::jsonb`
                  : sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'blockedMeta'`,
              };
        const coordinated = await tx
          .update(agentSessions)
          .set({
            nextAttemptAt: input.coordination.updateMode === 'if_missing'
              ? sql`COALESCE(${agentSessions.nextAttemptAt}, ${input.coordination.nextAttemptAt})`
              : input.coordination.nextAttemptAt,
            ...(input.coordination.revokeExecutionClaim
              ? { executionClaimToken: null, executionClaimExpiresAt: null }
              : {}),
            ...completionProjection,
            ...blockedProjection,
            updatedAt: new Date(),
          })
          .where(and(
            eq(agentSessions.id, input.sessionId),
            input.coordination.expectedExecutionClaimToken
              ? eq(agentSessions.executionClaimToken, input.coordination.expectedExecutionClaimToken)
              : undefined,
          ))
          .returning({ id: agentSessions.id });
        if (coordinated.length === 0) {
          throw new Error(
            input.coordination.expectedExecutionClaimToken
              ? 'execution_claim_lost'
              : `Cannot coordinate journal append: session ${input.sessionId} does not exist.`,
          );
        }
      }
      return rows.map((row) => this.toDomain(row));
    });
  }

  /**
   * `agent_messages` is an indexed read model, never a second history writer.
   * Keeping this projection in the journal transaction removes the old crash
   * window between accepting a semantic message and persisting its chat row.
   */
  private async projectTranscript(
    tx: TranscriptProjectionTransaction,
    sessionId: string,
    drafts: AppendSessionEventsInput['events'],
  ): Promise<void> {
    const requiresRebuild = drafts.some(
      (event) => event.eventType === 'legacy.session_imported'
        || event.eventType === 'compaction.applied'
        || event.eventType === 'session.recovery_rebased',
    );
    if (requiresRebuild) {
      const allRows = await tx
        .select()
        .from(agentSessionEvents)
        .where(eq(agentSessionEvents.sessionId, sessionId))
        .orderBy(asc(agentSessionEvents.sequence));
      const fold = foldSessionJournal(allRows.map((row) => this.toDomain(row)));
      if (fold.issues.length > 0) {
        throw new Error(
          `Cannot rebuild transcript projection for degraded journal ${sessionId}: ${fold.issues[0]?.detail ?? 'unknown issue'}`,
        );
      }
      await tx.delete(agentMessages).where(eq(agentMessages.sessionId, sessionId));
      if (fold.messages.length > 0) {
        await tx.insert(agentMessages).values(
          fold.messages.map((message) => this.toMessageProjection(sessionId, message)),
        );
      }
      return;
    }

    const messages: Message[] = [];
    for (const event of drafts) {
      const payload = event.payload as { message?: Message };
      if (
        event.eventType === 'input.accepted'
        || event.eventType === 'message.accepted'
        || event.eventType === 'model.response.accepted'
        || event.eventType === 'tool.outcome_attached'
      ) {
        if (payload.message) messages.push(payload.message);
      }
    }
    if (messages.length === 0) return;
    await tx
      .insert(agentMessages)
      .values(messages.map((message) => this.toMessageProjection(sessionId, message)));

  }

  private toMessageProjection(sessionId: string, message: Message): typeof agentMessages.$inferInsert {
    return {
      id: message.id,
      sessionId,
      role: message.role,
      content: message.content,
      toolName: message.toolName ?? null,
      toolCallId: message.toolCallId ?? message.tool_call_id ?? null,
      metadata: {
        ...(message.metadata ?? {}),
        ...(message.status ? { status: message.status } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      },
      createdAt: new Date(message.timestamp),
    };
  }

  async load(sessionId: string): Promise<SessionEventRecord[]> {
    const rows = await this.database
      .select()
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, sessionId))
      .orderBy(asc(agentSessionEvents.sequence));
    return rows.map((row) => this.toDomain(row));
  }

  async loadMany(sessionIds: readonly string[]): Promise<SessionEventRecord[]> {
    if (sessionIds.length === 0) return [];
    const rows = await this.database
      .select()
      .from(agentSessionEvents)
      .where(inArray(agentSessionEvents.sessionId, [...new Set(sessionIds)]))
      .orderBy(asc(agentSessionEvents.sessionId), asc(agentSessionEvents.sequence));
    return rows.map((row) => this.toDomain(row));
  }

  async loadAfter(sessionId: string, sequence: number): Promise<SessionEventRecord[]> {
    const rows = await this.database
      .select()
      .from(agentSessionEvents)
      .where(and(
        eq(agentSessionEvents.sessionId, sessionId),
        gt(agentSessionEvents.sequence, sequence),
      ))
      .orderBy(asc(agentSessionEvents.sequence));
    return rows.map((row) => this.toDomain(row));
  }

  async lastSequence(sessionId: string): Promise<number> {
    const [tail] = await this.database
      .select({ sequence: max(agentSessionEvents.sequence) })
      .from(agentSessionEvents)
      .where(eq(agentSessionEvents.sessionId, sessionId));
    return Number(tail?.sequence ?? 0);
  }

  private toDomain(row: typeof agentSessionEvents.$inferSelect): SessionEventRecord {
    return {
      eventId: row.eventId,
      sessionId: row.sessionId,
      sequence: row.sequence,
      eventType: row.eventType as SessionEventRecord['eventType'],
      schemaVersion: row.schemaVersion,
      payload: row.payload as SessionEventRecord['payload'],
      causationEventId: row.causationEventId ?? undefined,
      correlationId: row.correlationId ?? undefined,
      createdAt: row.createdAt,
    };
  }
}
