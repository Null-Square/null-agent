import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetLiveEventStream, subscribeToStream } from './liveEventStream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  static OPEN = 1;

  url: string;
  readyState = MockEventSource.OPEN;
  closed = false;
  listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.listeners.get(type)?.forEach((listener) => listener({ data } as MessageEvent<string>));
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

const live = () => MockEventSource.instances.filter((i) => !i.closed);

describe('liveEventStream', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    localStorage.clear();
    localStorage.setItem('access_token', 'token');
  });

  afterEach(() => {
    resetLiveEventStream();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens one connection no matter how many listeners there are', () => {
    // The reason this module exists. Two hooks each owning an EventSource
    // would mean two idle sockets per tab carrying identical bytes.
    const offA = subscribeToStream('notification', vi.fn());
    const offB = subscribeToStream('live', vi.fn());
    const offC = subscribeToStream('live', vi.fn());

    expect(MockEventSource.instances).toHaveLength(1);
    offA(); offB(); offC();
  });

  it('routes each channel only to its own listeners', () => {
    const onNotification = vi.fn();
    const onLive = vi.fn();
    const offA = subscribeToStream('notification', onNotification);
    const offB = subscribeToStream('live', onLive);

    MockEventSource.instances[0].emit('live', { kind: 'risk.created' });

    expect(onLive).toHaveBeenCalledWith({ kind: 'risk.created' });
    expect(onNotification).not.toHaveBeenCalled();
    offA(); offB();
  });

  it('keeps the socket while any listener remains, and closes after the last', () => {
    const offA = subscribeToStream('notification', vi.fn());
    const offB = subscribeToStream('live', vi.fn());

    offA();
    expect(live()).toHaveLength(1);

    offB();
    expect(live()).toHaveLength(0);
  });

  it('connects with no sign-in token, and never puts one in the address', () => {
    localStorage.clear();
    const off = subscribeToStream('live', vi.fn());
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).not.toContain('access_token');
    off();
  });

  it('survives a malformed frame without dropping the connection', () => {
    // A bad frame is the server's problem. Tearing down every live surface
    // over one unparseable payload would make it the customer's.
    const onLive = vi.fn();
    const off = subscribeToStream('live', onLive);

    MockEventSource.instances[0].emit('live', 'not json{');
    MockEventSource.instances[0].emit('live', { kind: 'run.changed' });

    expect(onLive).toHaveBeenCalledTimes(1);
    expect(onLive).toHaveBeenCalledWith({ kind: 'run.changed' });
    expect(live()).toHaveLength(1);
    off();
  });

  it('backs off between reconnects instead of retrying at a fixed rate', () => {
    // An expired token fails identically every time. The old fixed 5s retry
    // meant a tab left open with a dead token reconnected twelve times a
    // minute for as long as it stayed open.
    vi.useFakeTimers();
    const off = subscribeToStream('live', vi.fn());

    MockEventSource.instances[0].fail();
    vi.advanceTimersByTime(2_999);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    // Second failure waits longer than the first.
    MockEventSource.instances[1].fail();
    vi.advanceTimersByTime(3_000);
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(3_000);
    expect(MockEventSource.instances).toHaveLength(3);

    off();
  });

  it('stops reconnecting once the last listener has gone', () => {
    vi.useFakeTimers();
    const off = subscribeToStream('live', vi.fn());

    MockEventSource.instances[0].fail();
    off();
    vi.advanceTimersByTime(60_000);

    expect(MockEventSource.instances).toHaveLength(1);
  });
});
