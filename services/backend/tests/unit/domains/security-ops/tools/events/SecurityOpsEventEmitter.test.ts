import { describe, expect, it, vi } from 'vitest';

import { SecurityOpsEventEmitter } from '@/domains/security-ops/tools/events/SecurityOpsEventEmitter';
import { logger } from '@/shared/logger';
import { liveEventBus, orgTopic, type LiveEvent } from '@/app/adapters/events/liveEventBus';

const createDb = () => {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return {
    db: { insert },
    insert,
    values,
  };
};

describe('SecurityOpsEventEmitter', () => {
  it('does not dispatch automation events without an organization id', async () => {
    const { db, insert } = createDb();
    const automationService = {
      evaluateEvent: vi.fn().mockResolvedValue(undefined),
    };
    const emitter = new SecurityOpsEventEmitter({
      db: db as never,
      automationService,
    });

    await emitter.emitSecurityOpsEvent(undefined, {
      type: 'asset_discovered',
      payload: { assetId: 'asset-1' },
      summary: 'Asset discovered',
    });

    expect(automationService.evaluateEvent).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('dispatches security-ops tool events to automation', async () => {
    const { db, insert } = createDb();
    const automationService = {
      evaluateEvent: vi.fn().mockResolvedValue(undefined),
    };
    const emitter = new SecurityOpsEventEmitter({
      db: db as never,
      automationService,
    });

    await emitter.emitSecurityOpsEvent('org-1', {
      type: 'finding_created',
      payload: { findingId: 'finding-1' },
      summary: 'Finding created',
    });

    expect(automationService.evaluateEvent).toHaveBeenCalledWith('org-1', {
      type: 'finding_created',
      payload: { findingId: 'finding-1' },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('records failed automation dispatches for retry', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { db, values } = createDb();
    const error = new Error('automation unavailable');
    const automationService = {
      evaluateEvent: vi.fn().mockRejectedValue(error),
    };
    const emitter = new SecurityOpsEventEmitter({
      db: db as never,
      automationService,
    });

    await emitter.emitSecurityOpsEvent('org-1', {
      type: 'asset_discovered',
      payload: { assetId: 'asset-1' },
      summary: 'Asset discovered',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        eventType: 'automation.evaluate_event',
        payload: {
          channel: 'automation',
          source: 'securityops.tool_event',
          eventType: 'asset_discovered',
          eventPayload: { assetId: 'asset-1' },
        },
        retryCount: 0,
        error: 'automation unavailable',
      }),
    );
    loggerSpy.mockRestore();
  });

  it('records run system events', async () => {
    const { db, values } = createDb();
    const emitter = new SecurityOpsEventEmitter({ db: db as never });

    await emitter.emitRunSystemEvent('run-1', 'Run checkpoint recorded.');

    expect(values).toHaveBeenCalledWith({
      runId: 'run-1',
      type: 'system',
      note: 'Run checkpoint recorded.',
    });
  });

  /*
   * These events are also what tells a browser tab its lists are stale. The
   * cases below pin the two properties that make that trustworthy: the right
   * kind reaches the right organization, and it is not lost when the
   * automation dispatch beside it fails.
   */
  describe('live updates', () => {
    const listen = (organizationId: string) => {
      const received: LiveEvent[] = [];
      const off = liveEventBus.subscribe(orgTopic(organizationId), (event) => received.push(event));
      return { received, off };
    };

    it('maps a reported finding to a risk refresh for that organization', async () => {
      const { db } = createDb();
      const { received, off } = listen('org-1');
      const emitter = new SecurityOpsEventEmitter({ db: db as never });

      await emitter.emitSecurityOpsEvent('org-1', {
        type: 'finding_created',
        payload: { findingId: 'finding-1' },
        summary: 'Finding created',
      });

      expect(received).toEqual([{ kind: 'risk.created' }]);
      off();
    });

    it('maps a discovered asset to an asset refresh', async () => {
      const { db } = createDb();
      const { received, off } = listen('org-2');
      const emitter = new SecurityOpsEventEmitter({ db: db as never });

      await emitter.emitSecurityOpsEvent('org-2', {
        type: 'asset_discovered',
        payload: { assetId: 'asset-1' },
        summary: 'Asset discovered',
      });

      expect(received).toEqual([{ kind: 'asset.discovered' }]);
      off();
    });

    it('still refreshes the browser when the automation dispatch fails', async () => {
      // The reason the publish sits above the try/catch rather than inside it:
      // a broken automation rule is not a reason to also make the customer
      // refresh the page by hand to see their new finding.
      const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      const { db } = createDb();
      const { received, off } = listen('org-3');
      const emitter = new SecurityOpsEventEmitter({
        db: db as never,
        automationService: { evaluateEvent: vi.fn().mockRejectedValue(new Error('rule exploded')) },
      });

      await emitter.emitSecurityOpsEvent('org-3', {
        type: 'finding_created',
        payload: { findingId: 'finding-1' },
        summary: 'Finding created',
      });

      expect(received).toEqual([{ kind: 'risk.created' }]);
      loggerSpy.mockRestore();
      off();
    });

    it('publishes nothing without an organization id', async () => {
      const { db } = createDb();
      const { received, off } = listen('org-4');
      const emitter = new SecurityOpsEventEmitter({ db: db as never });

      await emitter.emitSecurityOpsEvent(undefined, {
        type: 'finding_created',
        payload: { findingId: 'finding-1' },
        summary: 'Finding created',
      });

      expect(received).toEqual([]);
      off();
    });
  });
});
