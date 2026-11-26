import { getPool } from '@/db/client';

const REQUIRED_TABLES = [
  'agent_sessions',
  'agent_messages',
  'agent_artifacts',
  'trace_index',
  'users',
  'organizations',
  'organization_members',
  'settings',
  'models',
  'usage_records',
  'notifications',
];
// Drizzle creates __drizzle_migrations under the "drizzle" schema by default; some setups use public.drizzle_migrations.
const MIGRATION_TABLES = ['drizzle.__drizzle_migrations', 'public.drizzle_migrations'];

export const ensureDatabaseSchema = async (): Promise<void> => {
  const pool = getPool();
  const missing: string[] = [];

  let migrationFound = false;
  for (const table of MIGRATION_TABLES) {
    const res = await pool.query<{ oid: string | null }>('select to_regclass($1) as oid', [table]);
    if (res.rows[0]?.oid) {
      migrationFound = true;
      break;
    }
  }
  if (!migrationFound) {
    missing.push('drizzle_migrations');
  }

  for (const table of REQUIRED_TABLES) {
    const result = await pool.query<{ oid: string | null }>('select to_regclass($1) as oid', [`public.${table}`]);
    const exists = result.rows[0]?.oid;
    if (!exists) {
      missing.push(table);
    }
  }

  if (missing.length > 0) {
    const message = `[Startup] Missing required tables: ${missing.join(
      ', ',
    )}. Run migrations (e.g., npm run db:migrate) before starting the API.`;
    throw new Error(message);
  }
};
