import { randomUUID } from 'crypto';
import type WebSocket from 'ws';
import { logger } from '@/shared/logger';

type RunnerMessage = Record<string, unknown> & {
  type: string;
  requestId?: string;
};

type RequestListener = (message: RunnerMessage) => void;
type DisconnectListener = () => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export class RunnerConnectionRegistry {
  private readonly log = logger.child({ scope: 'RunnerConnectionRegistry' });
  private readonly connections = new Map<string, WebSocket>();
  private readonly requestListeners = new Map<string, Set<RequestListener>>();
  private readonly disconnectListeners = new Map<string, Set<DisconnectListener>>();

  register(runnerId: string, ws: WebSocket): void {
    const existing = this.connections.get(runnerId);
    if (existing && existing !== ws) {
      try {
        existing.close(4000, 'superseded');
      } catch {
        // no-op
      }
    }
    this.connections.set(runnerId, ws);
  }

  unregister(runnerId: string, ws?: WebSocket): void {
    const existing = this.connections.get(runnerId);
    if (!existing) {
      return;
    }
    if (ws && existing !== ws) {
      return;
    }

    this.connections.delete(runnerId);

    const listeners = this.disconnectListeners.get(runnerId);
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          this.log.warn({ err: error, runnerId }, '[runner-registry] Disconnect listener failed');
        }
      }
    }
  }

  isConnected(runnerId: string): boolean {
    const ws = this.connections.get(runnerId);
    return Boolean(ws && ws.readyState === ws.OPEN);
  }

  onRunnerDisconnect(runnerId: string, listener: DisconnectListener): () => void {
    const listeners = this.disconnectListeners.get(runnerId) ?? new Set<DisconnectListener>();
    listeners.add(listener);
    this.disconnectListeners.set(runnerId, listeners);

    return () => {
      const current = this.disconnectListeners.get(runnerId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.disconnectListeners.delete(runnerId);
      }
    };
  }

  subscribeRequest(requestId: string, listener: RequestListener): () => void {
    const listeners = this.requestListeners.get(requestId) ?? new Set<RequestListener>();
    listeners.add(listener);
    this.requestListeners.set(requestId, listeners);

    return () => {
      const current = this.requestListeners.get(requestId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.requestListeners.delete(requestId);
      }
    };
  }

  send(runnerId: string, payload: Record<string, unknown>): void {
    const ws = this.connections.get(runnerId);
    if (!ws || ws.readyState !== ws.OPEN) {
      throw new Error(`runner_not_connected:${runnerId}`);
    }
    ws.send(JSON.stringify(payload));
  }

  async request<T extends RunnerMessage>(
    runnerId: string,
    payload: Record<string, unknown>,
    options: {
      responseTypes: string[];
      timeoutMs: number;
    },
  ): Promise<T> {
    const requestId =
      typeof payload.requestId === 'string' && payload.requestId.trim().length > 0
        ? payload.requestId.trim()
        : randomUUID();
    payload.requestId = requestId;

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribeMessage();
        unsubscribeDisconnect();
      };

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const unsubscribeMessage = this.subscribeRequest(requestId, (message) => {
        if (!options.responseTypes.includes(message.type)) {
          return;
        }
        settle(() => resolve(message as T));
      });

      const unsubscribeDisconnect = this.onRunnerDisconnect(runnerId, () => {
        settle(() => reject(new Error(`runner_disconnected:${runnerId}`)));
      });

      const timer = setTimeout(() => {
        settle(() => reject(new Error(`runner_request_timeout:${requestId}`)));
      }, Math.max(1_000, options.timeoutMs));

      try {
        this.send(runnerId, payload);
      } catch (error) {
        settle(() => reject(error));
      }
    });
  }

  handleIncomingMessage(runnerId: string, raw: unknown): void {
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf-8')
            : '';
      if (!text) {
        return;
      }

      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        this.log.warn({ runnerId }, '[runner-registry] Ignoring malformed runner message');
        return;
      }

      const message = parsed as RunnerMessage;
      if (typeof message.requestId !== 'string' || message.requestId.trim().length === 0) {
        return;
      }

      const listeners = this.requestListeners.get(message.requestId);
      if (!listeners || listeners.size === 0) {
        return;
      }

      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          this.log.warn(
            { err: error, runnerId, requestId: message.requestId },
            '[runner-registry] Request listener failed',
          );
        }
      }
    } catch (error) {
      this.log.warn({ err: error, runnerId }, '[runner-registry] Failed to handle runner message');
    }
  }
}

export const runnerConnectionRegistry = new RunnerConnectionRegistry();
