import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  publishRunCancellationSignal,
  RunControlSignalListener,
} from '@/domains/security-ops/runs/RunControlSignal';
import { setupTestDb } from '../../helpers/testDb';

const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timed out waiting for PostgreSQL notification')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

maybeDescribe('RunControlSignal integration', () => {
  let harness: NonNullable<Awaited<ReturnType<typeof setupTestDb>>>;

  beforeAll(async () => {
    const value = await setupTestDb();
    if (!value) throw new Error('TEST_DATABASE_URL is required');
    harness = value;
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it('delivers a cancellation from a publishing connection to an independent listener connection', async () => {
    const runId = randomUUID();
    let resolveConnected!: () => void;
    let resolveCancelled!: (value: string) => void;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const cancelled = new Promise<string>((resolve) => {
      resolveCancelled = resolve;
    });
    const listener = new RunControlSignalListener(
      async (receivedRunId) => resolveCancelled(receivedRunId),
      async () => resolveConnected(),
      harness.pool,
    );

    listener.start();
    try {
      await withTimeout(connected);
      await publishRunCancellationSignal(runId, harness.pool);
      await expect(withTimeout(cancelled)).resolves.toBe(runId);
    } finally {
      await listener.stop();
    }
  });

  it('reconnects when durable catch-up fails without leaking the first listener connection', async () => {
    const runId = randomUUID();
    let catchUpAttempts = 0;
    let resolveReconnected!: () => void;
    let resolveCancelled!: (value: string) => void;
    const reconnected = new Promise<void>((resolve) => {
      resolveReconnected = resolve;
    });
    const cancelled = new Promise<string>((resolve) => {
      resolveCancelled = resolve;
    });
    const listener = new RunControlSignalListener(
      async (receivedRunId) => resolveCancelled(receivedRunId),
      async () => {
        catchUpAttempts += 1;
        if (catchUpAttempts === 1) throw new Error('synthetic catch-up failure');
        resolveReconnected();
      },
      harness.pool,
    );

    listener.start();
    try {
      await withTimeout(reconnected, 8_000);
      await publishRunCancellationSignal(runId, harness.pool);
      await expect(withTimeout(cancelled)).resolves.toBe(runId);
      expect(catchUpAttempts).toBe(2);
    } finally {
      await listener.stop();
    }
  });
});
