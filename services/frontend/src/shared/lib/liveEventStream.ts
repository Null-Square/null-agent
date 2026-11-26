/**
 * The app's one server-sent-events connection.
 *
 * WHY A MODULE AND NOT A HOOK
 *
 * Two things now want the stream: the notification bell, and the live-refresh
 * of every list. Written as two hooks, each would construct its own
 * `EventSource` — two sockets per tab carrying the same bytes. Worse, an
 * `EventSource` owned by component state is torn down and rebuilt every time
 * its owner remounts, so a layout that swaps branches reconnects the socket as
 * a side effect of rendering.
 *
 * So the connection lives here, outside React, reference-counted. Hooks
 * subscribe and unsubscribe; the socket opens on the first subscriber and
 * closes after the last one leaves.
 *
 * WHAT COMES DOWN IT
 *
 *  - `notification` — a full notification row, for the bell
 *  - `live`         — a coarse "this changed" signal, answered with a refetch
 *  - `heartbeat`    — keep-alive, ignored
 *  - `connected`    — handshake, ignored
 */

import type { LiveEvent, LiveEventKind } from '@null-ai/contracts';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

/* Shared with the backend through `@null-ai/contracts` — see the note there
   on why a duplicated union would fail silently. */
export type { LiveEvent, LiveEventKind };

export type StreamChannel = 'notification' | 'live';

type Handler = (data: unknown) => void;

const handlers: Record<StreamChannel, Set<Handler>> = {
  notification: new Set(),
  live: new Set(),
};

/**
 * Backoff, because the failure being retried is usually not transient: an
 * expired token fails the handshake identically every time. The previous
 * fixed 5s retry meant a tab left open with a dead token reconnected twelve
 * times a minute for as long as it stayed open. Growing to 30s still
 * recovers from a real outage promptly, but makes a permanent failure cheap.
 */
const INITIAL_RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 30_000;

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelayMs = INITIAL_RECONNECT_MS;

const totalSubscribers = (): number => handlers.notification.size + handlers.live.size;

const dispatch = (channel: StreamChannel, raw: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed frame is the server's problem, not this tab's: drop it and
    // keep the socket, rather than tearing down every live surface.
    return;
  }
  for (const handler of handlers[channel]) {
    try {
      handler(parsed);
    } catch {
      // One bad subscriber must not stop the others being told.
    }
  }
};

const clearReconnect = (): void => {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
};

const close = (): void => {
  clearReconnect();
  source?.close();
  source = null;
};

const connect = (): void => {
  if (source || totalSubscribers() === 0) return;
  // Absent under SSR and in jsdom. Live updates are a progressive enhancement,
  // so the whole app must render without it rather than throw.
  if (typeof EventSource === 'undefined') return;

  // No sign-in: the backend treats every request from this computer as the local owner.
  const url = `${API_BASE}/api/notifications/stream`;
  const next = new EventSource(url, { withCredentials: true });
  source = next;

  next.onopen = () => {
    reconnectDelayMs = INITIAL_RECONNECT_MS;
  };

  next.addEventListener('notification', (event) => {
    dispatch('notification', (event as MessageEvent<string>).data);
  });
  next.addEventListener('live', (event) => {
    dispatch('live', (event as MessageEvent<string>).data);
  });

  next.onerror = () => {
    // Close and retry ourselves rather than leaving EventSource's own
    // reconnect to it: its retry has no ceiling and no way to stand down when
    // the last subscriber goes away.
    next.close();
    if (source === next) source = null;
    if (totalSubscribers() === 0) return;

    clearReconnect();
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };
};

/**
 * Listen to one channel. Returns the unsubscribe, which closes the shared
 * socket if it was the last listener.
 */
export const subscribeToStream = (channel: StreamChannel, handler: Handler): (() => void) => {
  handlers[channel].add(handler);
  connect();

  return () => {
    handlers[channel].delete(handler);
    if (totalSubscribers() === 0) close();
  };
};

/** Drops the connection and every listener. For tests and sign-out. */
export const resetLiveEventStream = (): void => {
  handlers.notification.clear();
  handlers.live.clear();
  close();
  reconnectDelayMs = INITIAL_RECONNECT_MS;
};
