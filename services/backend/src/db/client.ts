import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import '@/config/loadDotenv';
import { loadAppConfig } from '@/config/configSchema';
import { DB_HEALTH_CHECK_MS } from '@/config/timeouts';
import * as schema from './schema';

const env = loadAppConfig(process.env);

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: Number(env.DB_POOL_MAX ?? 10),
});

export const db = drizzle(pool, { schema });
export type DatabaseClient = typeof db;

export type DbHealthStatus = {
  ok: boolean;
  ms: number;
  error?: string;
};

export async function closeDb(): Promise<void> {
  await pool.end();
}

export const getPool = (): Pool => pool;

const formatDbError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

export async function checkDbHealth(timeoutMs: number = DB_HEALTH_CHECK_MS): Promise<DbHealthStatus> {
  const start = Date.now();
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('db_health_timeout')), timeoutMs);
  });
  const queryPromise = pool.query('SELECT 1');
  queryPromise.catch(() => undefined);

  try {
    await Promise.race([queryPromise, timeoutPromise]);
    return { ok: true, ms: Date.now() - start };
  } catch (error) {
    return { ok: false, ms: Date.now() - start, error: formatDbError(error) };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
