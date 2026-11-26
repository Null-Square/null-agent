import type { ToolExecutionPort, UsageStorePort } from '../../ports';
import type { SessionEventJournalPort } from '../../ports/SessionEventJournalPort';
import {
  foldSessionJournal,
  repairSessionTail,
  SESSION_EVENT_SCHEMA_VERSION,
  type SessionEventProposal,
  type SessionEventPayloadMap,
  type SessionEventRecord,
  type SessionJournalFold,
  type SessionRepairContinuation,
} from '../../domain/session-journal';
import { SessionJournalService, type JournalEventInput } from './SessionJournalService';

const MAX_REPAIR_PASSES = 8;

const latestDurableExecutionIntent = (
  events: readonly SessionEventRecord[],
  fallback: 'running' | 'stopped',
): 'running' | 'stopped' => {
  let intent = fallback;
  for (const event of events) {
    if (event.schemaVersion !== SESSION_EVENT_SCHEMA_VERSION
      || !event.payload
      || typeof event.payload !== 'object'
      || Array.isArray(event.payload)) continue;
    if (event.eventType === 'session.start_requested') intent = 'running';
    if (event.eventType === 'session.stop_requested') intent = 'stopped';
  }
  return intent;
};

export interface SessionJournalRecoveryResult {
  fold: SessionJournalFold;
  continuation: SessionRepairContinuation;
  repairedEventCount: number;
  repairedToolExecutionCount: number;
  repairedProviderAttemptCount: number;
}

export interface SessionJournalRecoveryOptions {
  /** The previous execution lease expired, proving its in-memory owner was lost. */
  executionInterrupted?: boolean;
  interruptedAt?: Date;
}

const repairEventKey = (event: SessionEventProposal): string => {
  switch (event.eventType) {
    case 'tool.requested': {
      const payload = event.payload as SessionEventPayloadMap['tool.requested'];
      return `repair:tool-requested:${payload.turnId}:${payload.toolCallId}`;
    }
    case 'tool.outcome_attached': {
      const payload = event.payload as SessionEventPayloadMap['tool.outcome_attached'];
      return `repair:tool-outcome:${payload.turnId}:${payload.toolCallId}:${payload.outcome}`;
    }
    case 'turn.interrupted': {
      const payload = event.payload as SessionEventPayloadMap['turn.interrupted'];
      return `repair:turn-interrupted:${payload.turnId}`;
    }
    case 'turn.completed': {
      const payload = event.payload as SessionEventPayloadMap['turn.completed'];
      return `repair:turn-completed:${payload.turnId}`;
    }
    default:
      throw new Error(`Unsupported synthetic recovery event ${event.eventType}.`);
  }
};

/**
 * Reconciles only the durable journal tail and effect ledger.
 *
 * It does not interpret UI statuses, run statuses, providers, credits, or
 * scheduling. The caller receives one provider-neutral continuation decision.
 */
export class SessionJournalRecoveryService {
  private readonly journal: SessionJournalService;

  constructor(
    journal: SessionEventJournalPort,
    private readonly toolExecutions: ToolExecutionPort,
    private readonly providerAttempts?: UsageStorePort,
  ) {
    this.journal = new SessionJournalService(journal);
  }

  async reconcile(
    sessionId: string,
    options: SessionJournalRecoveryOptions = {},
  ): Promise<SessionJournalRecoveryResult> {
    let repairedEventCount = 0;
    let repairedToolExecutionCount = 0;
    const repairedProviderAttemptCount = options.executionInterrupted
      ? await this.freezeInterruptedProviderAttempts(sessionId, options.interruptedAt ?? new Date())
      : 0;

    for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
      const events = await this.journal.load(sessionId);
      const fold = foldSessionJournal(events);
      if (fold.issues.length > 0) {
        const physicalTail = events.at(-1)?.sequence ?? 0;
        const firstIssue = fold.issues[0];
        if (firstIssue && fold.recoverableThroughSequence < physicalTail) {
          const rangeKey = `${fold.recoverableThroughSequence}:${physicalTail}`;
          // Stop/Start commands remain trustworthy control facts even if an
          // unrelated earlier row makes the remainder of the semantic tail
          // unreadable. Preserve the latest explicit intent in the rebase.
          const desiredExecution = latestDurableExecutionIntent(events, fold.desiredExecution);
          await this.journal.append(sessionId, [
            {
              idempotencyKey: `recovery-rebase:${rangeKey}`,
              event: {
                eventType: 'session.recovery_rebased',
                payload: {
                  recoverableThroughSequence: fold.recoverableThroughSequence,
                  abandonedThroughSequence: physicalTail,
                  reason: firstIssue.detail,
                  desiredExecution,
                },
                correlationId: 'data-loss-recovery',
              },
            },
            {
              idempotencyKey: `data-loss:${rangeKey}`,
              event: {
                eventType: 'session.data_loss_detected',
                payload: {
                  kind: firstIssue.code === 'sequence_gap' ? 'sequence_gap' : 'invalid_event',
                  detail: firstIssue.detail,
                  recoverableThroughSequence: fold.recoverableThroughSequence,
                },
                correlationId: 'data-loss-recovery',
              },
            },
          ]);
          repairedEventCount += 2;
          continue;
        }
        return {
          fold,
          continuation: { kind: 'none' },
          repairedEventCount,
          repairedToolExecutionCount,
          repairedProviderAttemptCount,
        };
      }

      const toolRecords = await this.toolExecutions.findBySession(sessionId);
      const plan = repairSessionTail(fold, toolRecords);

      if (plan.toolLedgerRepairs.length > 0) {
        for (const repair of plan.toolLedgerRepairs) {
          if (repair.target === 'outcome_unknown') {
            if (!this.toolExecutions.markOutcomeUnknown) {
              throw new Error('Tool execution adapter cannot freeze outcome_unknown recovery.');
            }
            await this.toolExecutions.markOutcomeUnknown({
              sessionId,
              toolCallId: repair.toolCallId,
              reason: repair.reason,
            });
          } else {
            if (!this.toolExecutions.block) {
              throw new Error('Tool execution adapter cannot freeze pre-dispatch recovery.');
            }
            await this.toolExecutions.block({
              sessionId,
              toolCallId: repair.toolCallId,
              reason: repair.reason,
            });
          }
          repairedToolExecutionCount += 1;
        }
        continue;
      }

      if (plan.events.length > 0) {
        const inputs: JournalEventInput[] = plan.events.map((event) => ({
          event,
          idempotencyKey: repairEventKey(event),
        }));
        await this.journal.append(sessionId, inputs);
        repairedEventCount += inputs.length;

        // An interrupted pre-response turn is intentionally closed before the
        // runtime opens its replacement turn. Preserve that decision after the
        // closer makes the folded tail idle.
        if (plan.continuation.kind === 'restart_turn') {
          return {
            fold: await this.journal.fold(sessionId),
            continuation: plan.continuation,
            repairedEventCount,
            repairedToolExecutionCount,
            repairedProviderAttemptCount,
          };
        }
        continue;
      }

      return {
        fold,
        continuation: plan.continuation,
        repairedEventCount,
        repairedToolExecutionCount,
        repairedProviderAttemptCount,
      };
    }

    throw new Error(`Session journal recovery exceeded ${MAX_REPAIR_PASSES} deterministic repair passes.`);
  }

  /**
   * A lost process cannot prove whether an in-flight provider request consumed
   * upstream resources. Freeze the financial ledger at `uncertain` before a
   * replacement request is allowed; a late authoritative settlement may still
   * complete an uncertain row through the normal idempotent settle path.
   */
  private async freezeInterruptedProviderAttempts(sessionId: string, interruptedAt: Date): Promise<number> {
    if (!this.providerAttempts?.listAttemptsBySession) return 0;
    const attempts = await this.providerAttempts.listAttemptsBySession(sessionId);
    const interrupted = attempts.filter((attempt) => attempt.state === 'started');
    for (const attempt of interrupted) {
      await this.providerAttempts.failAttempt({
        attemptId: attempt.attemptId,
        status: 'uncertain',
        requestCompletedAt: interruptedAt,
        errorClass: 'process_interrupted_before_settlement',
        retryDecision: 'retry',
      });
    }
    return interrupted.length;
  }
}
