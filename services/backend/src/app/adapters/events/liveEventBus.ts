/**
 * LiveEventBus — "something you are looking at just changed" signals, fanned
 * out to the browser tabs currently watching an organization.
 *
 * WHY THIS EXISTS
 *
 * Until this, the app refreshed when *you* caused a change (a mutation in your
 * own tab invalidated its query) or when a page happened to poll. Everything
 * an agent produced while you were not looking — a new Risk, a run reaching a
 * terminal state — sat invisible until a manual page refresh. For a product
 * whose whole value is agents working unattended, that is backwards.
 *
 * WHAT THIS IS NOT
 *
 * It is deliberately NOT an outbox, a durable event log, or a job queue. An
 * event carries no data the client needs to keep: it says only that risks
 * changed, and the client answers by refetching through the ordinary API. So a dropped event costs one stale panel until the next event or
 * navigation — never a lost write, never a corrupt cache. That is what lets
 * this be ~40 lines of Map instead of a table with retry semantics.
 *
 * Publish AFTER the transaction commits. The client's reaction is a refetch,
 * and a refetch that overtakes the commit reads the old rows and caches them.
 *
 * SCALING
 *
 * Subscribers live in this process's memory, which is correct while the API is
 * a single container (docker-compose.production.yml runs one `nullai-backend`,
 * no replicas). Add a second instance and a tab connected to instance A stops
 * seeing events published on instance B — silently. The in-house fix is the
 * pattern `RunControlSignal.ts` already uses: publish via `pg_notify` and have
 * each instance LISTEN. Only `publish`/`subscribe` below would change; no
 * caller and nothing in the browser would notice.
 */

import type { LiveEvent, LiveEventKind } from '@null-ai/contracts';

import { logger } from '@/shared/logger';

/*
 * Logged through the root logger with an explicit scope rather than a
 * `logger.child()` bound at module load. `RunService` imports this file, and
 * `RunService` is imported almost everywhere — a load-time call would silently
 * require every test that stubs the logger to also stub `child`, failing them
 * for a reason unrelated to what they test.
 */
const SCOPE = { scope: 'LiveEventBus' } as const;

/*
 * The kinds themselves live in `@null-ai/contracts` because both ends must
 * agree on the exact strings and a drift fails silently — the browser ignores
 * kinds it does not recognise, which is what makes version skew safe, so a
 * typo would just stop refreshing with nothing in any log.
 */
export type { LiveEvent, LiveEventKind };

export type LiveEventCallback = (event: LiveEvent) => void;

/** Events are addressed to an organization — every viewer of it should react. */
export const orgTopic = (organizationId: string): string => `org:${organizationId}`;

class LiveEventBus {
  private subscribers = new Map<string, Set<LiveEventCallback>>();

  subscribe(topic: string, callback: LiveEventCallback): () => void {
    let set = this.subscribers.get(topic);
    if (!set) {
      set = new Set();
      this.subscribers.set(topic, set);
    }
    set.add(callback);

    return () => {
      const current = this.subscribers.get(topic);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) this.subscribers.delete(topic);
    };
  }

  publish(topic: string, event: LiveEvent): void {
    const set = this.subscribers.get(topic);
    // The overwhelmingly common case: nobody has the app open. Publishing is
    // then free, which is what lets call sites emit unconditionally.
    if (!set || set.size === 0) return;

    for (const callback of set) {
      try {
        callback(event);
      } catch (error) {
        // One wedged SSE connection must not stop the others being told.
        logger.warn({ ...SCOPE, err: error, topic, kind: event.kind }, 'Live event subscriber threw');
      }
    }
  }

  /** Test/diagnostic seam. */
  subscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}

export const liveEventBus = new LiveEventBus();

/**
 * Publish to an organization, tolerating a missing id and never throwing.
 *
 * Call sites are mid-workflow — reporting a finding, transitioning a run — and
 * a live-update signal must never be able to fail the work it is reporting on.
 */
export const publishLiveEvent = (
  organizationId: string | null | undefined,
  event: LiveEvent,
): void => {
  if (!organizationId) return;
  try {
    liveEventBus.publish(orgTopic(organizationId), event);
  } catch (error) {
    logger.warn({ ...SCOPE, err: error, organizationId, kind: event.kind }, 'Live event publish failed');
  }
};
