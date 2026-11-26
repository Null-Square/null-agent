import { describe, expect, it, vi } from 'vitest';

import { liveEventBus, orgTopic, publishLiveEvent } from '@/app/adapters/events/liveEventBus';

describe('liveEventBus', () => {
  it('delivers an event to every subscriber on the topic', () => {
    const first = vi.fn();
    const second = vi.fn();
    const off1 = liveEventBus.subscribe(orgTopic('org-1'), first);
    const off2 = liveEventBus.subscribe(orgTopic('org-1'), second);

    publishLiveEvent('org-1', { kind: 'risk.created' });

    expect(first).toHaveBeenCalledWith({ kind: 'risk.created' });
    expect(second).toHaveBeenCalledWith({ kind: 'risk.created' });
    off1();
    off2();
  });

  it('never leaks an event across organizations', () => {
    // The whole tenant boundary of this feature is the topic string, so this
    // is the assertion that matters most in the file.
    const mine = vi.fn();
    const theirs = vi.fn();
    const off1 = liveEventBus.subscribe(orgTopic('org-1'), mine);
    const off2 = liveEventBus.subscribe(orgTopic('org-2'), theirs);

    publishLiveEvent('org-1', { kind: 'run.changed', runId: 'run-1' });

    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
    off1();
    off2();
  });

  it('stops delivering after unsubscribe and forgets the topic', () => {
    const handler = vi.fn();
    const off = liveEventBus.subscribe(orgTopic('org-3'), handler);
    off();

    publishLiveEvent('org-3', { kind: 'asset.discovered' });

    expect(handler).not.toHaveBeenCalled();
    // Dropped rather than kept as an empty Set — a connection churning tab
    // would otherwise grow the map for the process's lifetime.
    expect(liveEventBus.subscriberCount(orgTopic('org-3'))).toBe(0);
  });

  it('still notifies healthy subscribers when one throws', () => {
    // One wedged SSE connection must not silently cost every other viewer in
    // the organization their live updates.
    const broken = vi.fn(() => { throw new Error('socket gone'); });
    const healthy = vi.fn();
    const off1 = liveEventBus.subscribe(orgTopic('org-4'), broken);
    const off2 = liveEventBus.subscribe(orgTopic('org-4'), healthy);

    expect(() => publishLiveEvent('org-4', { kind: 'run.created' })).not.toThrow();

    expect(healthy).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });

  it('is a no-op without an organization id', () => {
    // Call sites are mid-workflow and pass whatever they have; publishing must
    // never be the thing that throws inside a finding report.
    const handler = vi.fn();
    const off = liveEventBus.subscribe(orgTopic('undefined'), handler);

    expect(() => publishLiveEvent(undefined, { kind: 'risk.created' })).not.toThrow();
    expect(() => publishLiveEvent(null, { kind: 'risk.created' })).not.toThrow();

    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it('costs nothing when nobody is connected', () => {
    expect(() => publishLiveEvent('org-nobody', { kind: 'risk.created' })).not.toThrow();
    expect(liveEventBus.subscriberCount(orgTopic('org-nobody'))).toBe(0);
  });
});
