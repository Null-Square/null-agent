import type { DatabaseClient } from '@/db/client';
import { runEvents } from '@/db/schema';
import type { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { FailedEventService } from '@/domains/security-ops/resilience/FailedEventService';
import { logger } from '@/shared/logger';
import { publishLiveEvent, type LiveEventKind } from '@/app/adapters/events/liveEventBus';

export type SecurityOpsToolEvent = {
  type: 'finding_created' | 'asset_discovered';
  payload: Record<string, unknown>;
  summary: string;
};

/**
 * Tool events already fan out to automation rules; each also means a list the
 * customer may be looking at is now out of date. The kinds are coarse because
 * the browser reacts by invalidating a query, not by reading the payload.
 */
const LIVE_EVENT_KIND: Record<SecurityOpsToolEvent['type'], LiveEventKind> = {
  finding_created: 'risk.created',
  asset_discovered: 'asset.discovered',
};

export type SecurityOpsEventEmitterDeps = {
  db: DatabaseClient;
  automationService?: Pick<AutomationService, 'evaluateEvent'>;
};

export class SecurityOpsEventEmitter {
  constructor(private readonly deps: SecurityOpsEventEmitterDeps) {}

  async emitSecurityOpsEvent(
    organizationId: string | undefined,
    event: SecurityOpsToolEvent,
  ): Promise<void> {
    if (!organizationId) {
      return;
    }

    // Announced before the automation work below, and never inside its
    // try/catch: a rule that throws must not also cost the customer their
    // live refresh. Both callers emit after their transaction commits, so a
    // tab that refetches on this event reads the row that caused it.
    publishLiveEvent(organizationId, { kind: LIVE_EVENT_KIND[event.type] });

    const failedEventService = new FailedEventService(this.deps.db);

    if (this.deps.automationService) {
      try {
        await this.deps.automationService.evaluateEvent(organizationId, {
          type: event.type,
          payload: event.payload,
        });
      } catch (error) {
        logger.error(
          { err: error, organizationId, eventType: event.type },
          '[security-ops] Automation event dispatch failed',
        );
        await failedEventService.recordFailure({
          organizationId,
          eventType: 'automation.evaluate_event',
          payload: {
            channel: 'automation',
            source: 'securityops.tool_event',
            eventType: event.type,
            eventPayload: event.payload,
          },
          error,
        });
      }
    }
  }

  async emitRunSystemEvent(
    runId: string | undefined,
    note: string,
  ): Promise<void> {
    if (!runId) {
      return;
    }

    await this.deps.db.insert(runEvents).values({
      runId,
      type: 'system',
      note,
    });
  }
}
