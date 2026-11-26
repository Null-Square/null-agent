import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'path';
import fs from 'fs';
import * as schema from '@/db/schema';

export type TestDb = {
  pool: Pool;
  db: ReturnType<typeof drizzle<typeof schema>>;
  truncateAll: () => Promise<void>;
  dispose: () => Promise<void>;
};

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');
const migrationJournal = JSON.parse(
  fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
) as { entries?: Array<{ when?: number }> };
const CLEAN_BASELINE_MIGRATION_COUNT = migrationJournal.entries?.length ?? 0;
const CLEAN_BASELINE_LAST_MIGRATION_TS = migrationJournal.entries?.at(-1)?.when ?? 0;
const TEST_DB_SETUP_MAX_ATTEMPTS = 30;

type SqlClient = Pick<PoolClient, 'query'>;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableTestDbSetupError = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return (
    code === '57P03' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    message.includes('database system is starting up') ||
    message.includes('database system is in recovery mode') ||
    message.includes('connection terminated unexpectedly')
  );
};

const queryDriftState = async (client: SqlClient) => {
  const [
    schemaRes,
    knownTablesRes,
    schedulingShapeRes,
    partnerShapeRes,
    partnerStepShapeRes,
    partnerLogoShapeRes,
    partnerCommissionShapeRes,
    modelRuntimeShapeRes,
    legalGateShapeRes,
    billingAuthorityShapeRes,
  ] = await Promise.all([
    client.query(
      "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS migrations_table",
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('agent_artifacts', 'agent_sessions', 'users', 'models', 'runs')`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'runners'
         AND column_name IN ('detected_memory_mb', 'detected_container_slots', 'derived_active_run_limit', 'capacity_source')`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (
           'partners',
           'partner_memberships',
           'partner_applications',
           'partner_application_revisions',
           'partner_application_events',
           'partner_agreement_acceptances',
           'referral_links',
           'referrals'
         )`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM pg_constraint AS constraint_row
       INNER JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
       INNER JOIN pg_namespace AS schema_row ON schema_row.oid = table_row.relnamespace
       WHERE schema_row.nspname = 'public'
         AND table_row.relname = 'partner_applications'
         AND constraint_row.conname = 'partner_applications_current_step_check'
         AND constraint_row.contype = 'c'`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'partners'
         AND column_name = 'logo_object_key'`,
    ),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'partner_commission_plan_previews'`,
    ),
    client.query(
      `SELECT (
         EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'usage_records'
             AND column_name = 'session_id'
             AND is_nullable = 'YES'
         )
         AND EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'usage_records_session_id_agent_sessions_id_fk'
             AND confdeltype = 'n'
         )
         AND EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conname = 'usage_records_token_check'
             AND pg_get_constraintdef(oid) LIKE '%total_tokens%prompt_tokens%cached_prompt_tokens%completion_tokens%'
         )
       ) AS ready`,
    ),
    /* Signup acceptance rides inside 0002 rather than a migration of its own, so
       neither the journal's entry count nor its last timestamp moves when it
       lands. A database that predates it is therefore indistinguishable from a
       current one unless the shape itself is probed. */
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'agreement_acceptances'`,
    ),
    client.query(
      `SELECT (
         EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'billing_transactions'
             AND column_name = 'canonical_plan_slug'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'organization_credit_adjustments'
             AND column_name = 'provider'
         )
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN (
               'billing_provider_customers',
               'billing_entitlement_grants',
               'billing_transaction_commercial_snapshots'
             )
         )
       ) AS ready`,
    ),
  ]);

  let lastMigrationMillis = 0;
  let migrationCount = 0;
  const migrationsTable = schemaRes.rows[0]?.migrations_table as string | null;
  if (migrationsTable) {
    const lastMigrationRes = await client.query(
      'SELECT COALESCE(MAX(created_at), 0)::bigint AS last_migration, COUNT(*)::int AS migration_count FROM drizzle.__drizzle_migrations',
    );
    lastMigrationMillis = Number(lastMigrationRes.rows[0]?.last_migration ?? 0);
    migrationCount = Number(lastMigrationRes.rows[0]?.migration_count ?? 0);
  }

  return {
    hasMigrationState: Boolean(migrationsTable),
    migrationCount,
    lastMigrationMillis,
    knownAppTableCount: Number(knownTablesRes.rows[0]?.count ?? 0),
    hasCurrentSchedulingShape: Number(schedulingShapeRes.rows[0]?.count ?? 0) === 4,
    hasCurrentPartnerShape: Number(partnerShapeRes.rows[0]?.count ?? 0) === 8,
    hasCurrentPartnerStepShape: Number(partnerStepShapeRes.rows[0]?.count ?? 0) === 1,
    hasCurrentPartnerLogoShape: Number(partnerLogoShapeRes.rows[0]?.count ?? 0) === 1,
    hasCurrentPartnerCommissionShape: Number(partnerCommissionShapeRes.rows[0]?.count ?? 0) === 1,
    hasCurrentModelRuntimeShape: modelRuntimeShapeRes.rows[0]?.ready === true,
    hasCurrentLegalGateShape: Number(legalGateShapeRes.rows[0]?.count ?? 0) === 1,
    hasCurrentBillingAuthorityShape: billingAuthorityShapeRes.rows[0]?.ready === true,
  };
};

const repairDriftedTestSchema = async (client: SqlClient) => {
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  `);
};

/**
 * Spin up a real Postgres test DB (requires TEST_DATABASE_URL).
 * Runs migrations once per instantiation and provides a truncate helper.
 * Returns undefined if TEST_DATABASE_URL is not set (for graceful skipping).
 */
export async function setupTestDb(): Promise<TestDb | undefined> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    // Return undefined instead of throwing - allows tests to gracefully skip
    return undefined;
  }

  const pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    // Prevent unhandled pool errors from crashing the test runner.
    console.warn('[testDb] Postgres pool error', err);
  });
  const db = drizzle(pool, { schema });

  let migrated = false;
  let attempts = 0;
  while (!migrated && attempts < TEST_DB_SETUP_MAX_ATTEMPTS) {
    // Multiple integration test files can call setupTestDb concurrently.
    // Guard migrations behind a global advisory lock to avoid DDL races
    // (e.g. two workers creating the same table at the same time).
    let migrationClient: PoolClient | null = null;
    try {
      attempts += 1;
      migrationClient = await pool.connect();
      await migrationClient.query('SELECT pg_advisory_lock(12346);');

      // Local test databases may carry pre-3.1 migration history. Reset only
      // test schemas that do not match the current clean baseline checkpoint.
      const driftState = await queryDriftState(migrationClient);
      const hasSquashedMigrationDrift =
        driftState.hasMigrationState &&
        (driftState.migrationCount !== CLEAN_BASELINE_MIGRATION_COUNT ||
          driftState.lastMigrationMillis !== CLEAN_BASELINE_LAST_MIGRATION_TS ||
          !driftState.hasCurrentSchedulingShape ||
          !driftState.hasCurrentPartnerShape ||
          !driftState.hasCurrentPartnerStepShape ||
          !driftState.hasCurrentPartnerLogoShape ||
          !driftState.hasCurrentPartnerCommissionShape ||
          !driftState.hasCurrentModelRuntimeShape ||
          !driftState.hasCurrentLegalGateShape ||
          !driftState.hasCurrentBillingAuthorityShape);
      const hasTablesWithoutMigrationState =
        !driftState.hasMigrationState &&
        driftState.knownAppTableCount > 0;
      if (hasSquashedMigrationDrift || hasTablesWithoutMigrationState) {
        await repairDriftedTestSchema(migrationClient);
      }

      const migrationDb = drizzle(migrationClient, { schema });
      await migrate(migrationDb, { migrationsFolder: MIGRATIONS_FOLDER });
      migrated = true;
    } catch (err) {
      if (attempts >= TEST_DB_SETUP_MAX_ATTEMPTS || !isRetryableTestDbSetupError(err)) {
        throw err;
      }
      await delay(Math.min(1_000, 200 * attempts));
    } finally {
      if (migrationClient) {
        // Best-effort unlock. If the lock was never acquired, Postgres returns false.
        try {
          await migrationClient.query('SELECT pg_advisory_unlock(12346);');
        } catch {
          // ignore
        }
        migrationClient.release();
      }
    }
  }

  const truncateAll = async () => {
    // Use advisory lock to prevent deadlocks when multiple tests try to truncate simultaneously
    await pool.query(`
      SELECT pg_advisory_lock(12345);
      TRUNCATE TABLE
        tool_execution_records,
        agent_messages,
        agent_artifacts,
        agent_checkpoints,
        agent_sessions
      RESTART IDENTITY CASCADE;
      SELECT pg_advisory_unlock(12345);
    `);
  };

  const dispose = async () => {
    await pool.end();
  };

  return { pool, db, truncateAll, dispose };
}
