import type { Pool, PoolClient } from 'pg';

/** Result of a non-blocking PostgreSQL session advisory lock. */
export type AdvisoryLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

type PoolLike = Pick<Pool, 'connect'>;

const releaseClient = (client: PoolClient, error?: unknown): void => {
  client.release(error instanceof Error ? error : undefined);
};

/**
 * Own cross-replica work without holding a database transaction across network
 * I/O. The dedicated connection owns the lock and is always released. If the
 * explicit unlock fails, the connection is destroyed so it cannot return to
 * the pool carrying a session lock.
 */
export async function withPostgresAdvisoryLock<T>(
  pool: PoolLike,
  key: string,
  run: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const client = await pool.connect();
  let acquired = false;
  let workError: unknown;
  let result: AdvisoryLockResult<T> | undefined;

  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    acquired = lock.rows[0]?.acquired === true;
    result = acquired
      ? { acquired: true, value: await run() }
      : { acquired: false };
  } catch (error) {
    workError = error;
  } finally {
    if (!acquired) {
      releaseClient(client, workError);
    } else {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]);
        releaseClient(client, workError);
      } catch (unlockError) {
        releaseClient(client, unlockError);
        workError ??= unlockError;
      }
    }
  }

  if (workError) throw workError;
  if (!result) throw new Error('PostgreSQL advisory lock completed without a result');
  return result;
}
