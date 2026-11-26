import { and, asc, eq, lt, lte } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { failedEvents, type AutomationEventType } from '@/db/schema';
import type { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { getErrorMessage } from '@/shared/errors';
import { logger } from '@/shared/logger';

export const FAILED_EVENT_RETRY_MAX = 3;
export const FAILED_EVENT_RETRY_BASE_DELAY_MS = 60_000;
const DEFAULT_RETRY_BATCH_SIZE = 100;

type FailedEventChannel = 'automation';

type FailedEventPayload = {
  channel: FailedEventChannel;
  source?: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  summary?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asPayload = (value: unknown): FailedEventPayload | null => {
  if (!isRecord(value)) return null;

  const channel = value.channel;
  const eventType = value.eventType;
  const eventPayload = value.eventPayload;
  if (
    channel !== 'automation' ||
    typeof eventType !== 'string' ||
    !isRecord(eventPayload)
  ) {
    return null;
  }
  return {
    channel,
    eventType,
    eventPayload,
    source: typeof value.source === 'string' ? value.source : undefined,
    summary: typeof value.summary === 'string' ? value.summary : undefined,
  };
};

const isAutomationEventType = (value: string): value is AutomationEventType =>
  value === 'finding_created' ||
  value === 'risk_state_changed' ||
  value === 'run_completed' ||
  value === 'asset_discovered' ||
  value === 'runner_offline';

const truncateError = (errorMessage: string): string => errorMessage.slice(0, 4_000);

export type FailedEventRecordInput = {
  organizationId: string;
  eventType: string;
  payload: FailedEventPayload;
  error: unknown;
};

export type FailedEventRetryResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  exhausted: number;
};

export class FailedEventService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly options?: {
      now?: () => Date;
      retryMax?: number;
      retryBaseDelayMs?: number;
    },
  ) {}

  async recordFailure(input: FailedEventRecordInput): Promise<void> {
    const now = this.now();
    try {
      await this.db.insert(failedEvents).values({
        organizationId: input.organizationId,
        eventType: input.eventType,
        payload: input.payload,
        error: truncateError(getErrorMessage(input.error)),
        retryCount: 0,
        nextRetryAt: this.computeNextRetryAt(now, 0),
        createdAt: now,
      });
    } catch (persistError) {
      logger.error(
        { err: persistError, organizationId: input.organizationId, eventType: input.eventType },
        '[failed-events] Failed to persist failed event',
      );
    }
  }

  async retryDueFailures(
    deps: {
      automationService: Pick<AutomationService, 'evaluateEvent'>;
      limit?: number;
    },
  ): Promise<FailedEventRetryResult> {
    const now = this.now();
    const retryMax = this.retryMax();
    const limit = Math.max(1, Math.min(deps.limit ?? DEFAULT_RETRY_BATCH_SIZE, 500));

    const dueRows = await this.db
      .select()
      .from(failedEvents)
      .where(
        and(
          lte(failedEvents.nextRetryAt, now),
          lt(failedEvents.retryCount, retryMax),
        ),
      )
      .orderBy(asc(failedEvents.nextRetryAt))
      .limit(limit);

    const result: FailedEventRetryResult = {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      exhausted: 0,
    };

    for (const row of dueRows) {
      result.attempted += 1;
      try {
        await this.dispatchRow(row.organizationId, row.payload, deps);
        await this.db.delete(failedEvents).where(eq(failedEvents.id, row.id));
        result.succeeded += 1;
      } catch (error) {
        result.failed += 1;
        const nextRetryCount = row.retryCount + 1;
        const nextRetryAt = this.computeNextRetryAt(now, nextRetryCount);
        if (!nextRetryAt) {
          result.exhausted += 1;
        }

        await this.db
          .update(failedEvents)
          .set({
            retryCount: nextRetryCount,
            error: truncateError(getErrorMessage(error)),
            nextRetryAt,
          })
          .where(eq(failedEvents.id, row.id));
      }
    }

    return result;
  }

  private async dispatchRow(
    organizationId: string,
    rawPayload: unknown,
    deps: {
      automationService: Pick<AutomationService, 'evaluateEvent'>;
    },
  ): Promise<void> {
    const payload = asPayload(rawPayload);
    if (!payload) {
      throw new Error('Invalid failed event payload');
    }

    if (payload.channel === 'automation') {
      if (!isAutomationEventType(payload.eventType)) {
        throw new Error(`Unsupported automation event type: ${payload.eventType}`);
      }

      await deps.automationService.evaluateEvent(organizationId, {
        type: payload.eventType,
        payload: payload.eventPayload,
      });
      return;
    }
  }

  private now(): Date {
    return this.options?.now?.() ?? new Date();
  }

  private retryMax(): number {
    return this.options?.retryMax ?? FAILED_EVENT_RETRY_MAX;
  }

  private retryBaseDelayMs(): number {
    return this.options?.retryBaseDelayMs ?? FAILED_EVENT_RETRY_BASE_DELAY_MS;
  }

  private computeNextRetryAt(now: Date, retryCount: number): Date | null {
    if (retryCount >= this.retryMax()) {
      return null;
    }

    const backoffMultiplier = retryCount <= 0 ? 1 : 2 ** (retryCount - 1);
    const delayMs = this.retryBaseDelayMs() * backoffMultiplier;
    return new Date(now.getTime() + delayMs);
  }
}
