import { describe, expect, it, vi } from 'vitest';

import { withPostgresAdvisoryLock } from '@/db/postgresAdvisoryLock';

const pool = (lockAcquired: boolean, unlockError?: Error) => {
  const release = vi.fn();
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [{ acquired: lockAcquired }] });
  if (lockAcquired) {
    if (unlockError) query.mockRejectedValueOnce(unlockError);
    else query.mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
  }
  return {
    value: { connect: vi.fn().mockResolvedValue({ query, release }) } as never,
    query,
    release,
  };
};

describe('withPostgresAdvisoryLock', () => {
  it('runs work only for the owner and explicitly unlocks before release', async () => {
    const holder = pool(true);
    const run = vi.fn().mockResolvedValue('done');

    await expect(withPostgresAdvisoryLock(holder.value, 'cycle', run)).resolves.toEqual({
      acquired: true,
      value: 'done',
    });
    expect(run).toHaveBeenCalledOnce();
    expect(holder.query).toHaveBeenCalledTimes(2);
    expect(holder.release).toHaveBeenCalledWith(undefined);
  });

  it('returns immediately when another replica owns the lock', async () => {
    const holder = pool(false);
    const run = vi.fn();

    await expect(withPostgresAdvisoryLock(holder.value, 'cycle', run)).resolves.toEqual({
      acquired: false,
    });
    expect(run).not.toHaveBeenCalled();
    expect(holder.release).toHaveBeenCalledOnce();
  });

  it('unlocks and releases when owned work fails', async () => {
    const holder = pool(true);
    const failure = new Error('cycle failed');

    await expect(
      withPostgresAdvisoryLock(holder.value, 'cycle', () => Promise.reject(failure)),
    ).rejects.toThrow('cycle failed');
    expect(holder.query).toHaveBeenCalledTimes(2);
    expect(holder.release).toHaveBeenCalledWith(failure);
  });

  it('destroys the connection if explicit unlock fails', async () => {
    const unlockError = new Error('unlock failed');
    const holder = pool(true, unlockError);

    await expect(
      withPostgresAdvisoryLock(holder.value, 'cycle', () => Promise.resolve('done')),
    ).rejects.toThrow('unlock failed');
    expect(holder.release).toHaveBeenCalledWith(unlockError);
  });
});
