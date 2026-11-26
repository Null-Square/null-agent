import type { Pool, PoolClient } from 'pg';

import { getPool } from '@/db/client';
import { logger } from '@/shared/logger';

const CHANNEL = 'null_ai_run_control';
const RECONNECT_MS = 2_000;

type RunControlMessage = {
  schemaVersion: 1;
  type: 'cancel';
  runId: string;
  publishedAt: string;
};

const parseMessage = (payload: string | undefined): RunControlMessage | null => {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<RunControlMessage>;
    if (
      parsed.schemaVersion === 1
      && parsed.type === 'cancel'
      && typeof parsed.runId === 'string'
      && parsed.runId.trim()
    ) {
      return {
        schemaVersion: 1,
        type: 'cancel',
        runId: parsed.runId.trim(),
        publishedAt: typeof parsed.publishedAt === 'string'
          ? parsed.publishedAt
          : new Date().toISOString(),
      };
    }
  } catch {
    // Malformed notifications are ignored. Durable Run state stays authoritative.
  }
  return null;
};

type RunControlPool = Pick<Pool, 'connect' | 'query'>;

export const publishRunCancellationSignal = async (
  runId: string,
  pool: RunControlPool = getPool(),
): Promise<void> => {
  const normalized = runId.trim();
  if (!normalized) return;
  const message: RunControlMessage = {
    schemaVersion: 1,
    type: 'cancel',
    runId: normalized,
    publishedAt: new Date().toISOString(),
  };
  await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(message)]);
};

export class RunControlSignalListener {
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting = false;
  private readonly releasedClients = new WeakSet<PoolClient>();

  constructor(
    private readonly onCancellation: (runId: string) => Promise<void>,
    private readonly onConnectedCatchUp?: () => Promise<void>,
    private readonly pool: RunControlPool = getPool(),
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    if (client) {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.removeAllListeners('end');
      await client.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
      this.releaseClient(client);
    }
  }

  private releaseClient(client: PoolClient, destroy = false): void {
    if (this.releasedClients.has(client)) return;
    this.releasedClients.add(client);
    if (this.client === client) this.client = null;
    client.removeAllListeners('notification');
    client.removeAllListeners('error');
    client.removeAllListeners('end');
    client.release(destroy);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_MS);
    this.reconnectTimer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.client) return;
    this.connecting = true;
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      if (this.stopped) {
        this.releaseClient(client);
        return;
      }
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      let disconnectHandled = false;
      client.on('notification', (notification) => {
        if (notification.channel !== CHANNEL) return;
        const message = parseMessage(notification.payload);
        if (!message) return;
        void this.onCancellation(message.runId).catch((error) => {
          logger.warn({ err: error, runId: message.runId }, '[RunControl] Cancellation signal handler failed');
        });
      });
      const disconnected = () => {
        if (disconnectHandled) return;
        disconnectHandled = true;
        if (this.client === client) {
          this.client = null;
        }
        if (client) this.releaseClient(client, true);
        this.scheduleReconnect();
      };
      client.once('error', disconnected);
      client.once('end', disconnected);
      await this.onConnectedCatchUp?.();
      logger.info('[RunControl] PostgreSQL cancellation listener connected');
    } catch (error) {
      if (client) this.releaseClient(client, true);
      logger.warn({ err: error }, '[RunControl] PostgreSQL cancellation listener connection failed');
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }
}
