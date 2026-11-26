import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

import {
  SessionJournalConflictError,
  type AppendSessionEventsInput,
  type SessionEventJournalPort,
} from '../../ports';
import {
  foldSessionJournal,
  type SessionEventProposal,
  type SessionEventRecord,
  type SessionJournalFold,
} from '../../domain/session-journal';

const EVENT_ID_NAMESPACE = 'c3df155b-04c7-4f0f-8df8-24f74eb06a59';
const MAX_APPEND_ATTEMPTS = 5;

export interface JournalEventInput {
  event: SessionEventProposal;
  /** Stable identity for acknowledgement-lost or command retries. */
  idempotencyKey?: string;
}

/**
 * Small application service around the journal port.
 *
 * It owns event identity and bounded optimistic retries. It contains no runtime
 * status policy; reconstruction remains the pure domain fold.
 */
export class SessionJournalService {
  constructor(private readonly journal: SessionEventJournalPort) {}

  async append(
    sessionId: string,
    inputs: readonly JournalEventInput[],
    coordination?: AppendSessionEventsInput['coordination'],
  ): Promise<SessionEventRecord[]> {
    if (inputs.length === 0) return [];
    const drafts = inputs.map(({ event, idempotencyKey }) => ({
      ...event,
      eventId: idempotencyKey
        ? uuidv5(`${sessionId}:${idempotencyKey}`, EVENT_ID_NAMESPACE)
        : uuidv4(),
    }));

    let lastConflict: SessionJournalConflictError | undefined;
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      const expectedSequence = await this.journal.lastSequence(sessionId);
      try {
        return await this.journal.append({
          sessionId,
          expectedSequence,
          events: drafts,
          ...(coordination ? { coordination } : {}),
        });
      } catch (error) {
        if (!(error instanceof SessionJournalConflictError)) throw error;
        lastConflict = error;
      }
    }
    throw lastConflict ?? new Error(`Session journal append failed for ${sessionId}.`);
  }

  async load(sessionId: string): Promise<SessionEventRecord[]> {
    return this.journal.load(sessionId);
  }

  async fold(sessionId: string): Promise<SessionJournalFold> {
    return foldSessionJournal(await this.load(sessionId));
  }

  async foldMany(sessionIds: readonly string[]): Promise<Map<string, SessionJournalFold>> {
    if (sessionIds.length === 0) return new Map();
    const events = this.journal.loadMany
      ? await this.journal.loadMany(sessionIds)
      : (await Promise.all(sessionIds.map((sessionId) => this.journal.load(sessionId)))).flat();
    const bySession = new Map<string, SessionEventRecord[]>();
    for (const event of events) {
      const group = bySession.get(event.sessionId) ?? [];
      group.push(event);
      bySession.set(event.sessionId, group);
    }
    return new Map(
      [...new Set(sessionIds)].map((sessionId) => [
        sessionId,
        foldSessionJournal(bySession.get(sessionId) ?? []),
      ]),
    );
  }
}
