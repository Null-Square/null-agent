#!/usr/bin/env node
/* Reset the Postgres database by dropping/recreating schema and rerunning migrations. */
const path = require('path');
const { Client } = require('pg');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
const defaultsEnvPath = path.join(backendRoot, '.env.example');
const localEnvPath = path.join(backendRoot, '.env.local');
dotenv.config({ path: defaultsEnvPath });
dotenv.config({ path: localEnvPath, override: true });

const resolveCandidates = () => {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DEV_DB_PORT || process.env.POSTGRES_PORT || '15432';
  const user = process.env.POSTGRES_USER || 'postgres';
  const password = process.env.POSTGRES_PASSWORD || 'postgres';
  const db = process.env.POSTGRES_DB || 'nullai_chat';
  const fallback = `postgres://${user}:${password}@${host}:${port}/${db}`;

  const candidates = [
    { url: process.env.DB_RESET_URL, reason: 'DB_RESET_URL' },
    { url: process.env.DATABASE_URL, reason: 'DATABASE_URL' },
    { url: process.env.DB_URL, reason: 'DB_URL' },
    { url: fallback, reason: 'fallback (DEV_DB_PORT/15432)' },
  ]
    .filter((c) => c.url)
    // dedupe by URL
    .filter(
      (c, idx, arr) =>
        arr.findIndex((other) => other.url === c.url) === idx,
    );

  return candidates;
};

const candidates = resolveCandidates();
if (candidates.length === 0) {
  console.error('[db:reset] No connection string candidates found.');
  process.exit(1);
}

let chosen = candidates[0];

const redact = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return url;
  }
};

const log = (msg) => console.log(`[db:reset] ${msg}`);
const fail = (msg, err) => {
  console.error(`[db:reset] ${msg}`);
  if (err) {
    console.error(err);
    if (err.code === 'ECONNREFUSED') {
      console.error(
        `[db:reset] Connection refused. Is Postgres running at ${redact(chosen.url)}? ` +
        'Start the dev database with "docker compose up -d dev-ports" from the repository root, or set DB_RESET_URL to the correct connection string.',
      );
    }
  }
  process.exit(1);
};

const dropAndRecreate = async () => {
  let lastError;
  for (const candidate of candidates) {
    const client = new Client({ connectionString: candidate.url });
    try {
      chosen = candidate;
      log(`Attempting connection (${candidate.reason}): ${redact(candidate.url)}`);
      await client.connect();
      log(`Connected using ${candidate.reason}`);
      log('Dropping and recreating schema "public" and dropping "drizzle"...');
      await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE;');
      await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
      await client.query('CREATE SCHEMA public;');
      await client.query('GRANT ALL ON SCHEMA public TO public;');
      await client.end().catch(() => undefined);
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      log(`Connection failed (${candidate.reason}): ${(error && error.message) || error}`);
    }
  }
  fail('All connection attempts failed.', lastError);
};

const runMigrations = () => {
  log('Running migrations (npm run db:migrate)...');
  const env = {
    ...process.env,
    DATABASE_URL: chosen.url,
    DB_URL: chosen.url,
  };
  const result = spawnSync('npm', ['run', 'db:migrate'], {
    cwd: backendRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (result.status !== 0) {
    fail('Migrations failed.');
  }
};

const runSeed = () => {
  log('Running seed (npm run db:seed)...');
  const env = {
    ...process.env,
    DATABASE_URL: chosen.url,
    DB_URL: chosen.url,
  };
  const result = spawnSync('npm', ['run', 'db:seed'], {
    cwd: backendRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (result.status !== 0) {
    fail('Seed failed.');
  }
};

/**
 * Resolve the test database URL from .env.test or construct from main DB URL.
 * Returns null if test database setup should be skipped.
 */
const resolveTestDbUrl = () => {
  // Load .env.test if it exists
  const testEnvPath = path.join(backendRoot, '.env.test');
  try {
    const testEnv = dotenv.parse(require('fs').readFileSync(testEnvPath));
    if (testEnv.TEST_DATABASE_URL) {
      return testEnv.TEST_DATABASE_URL;
    }
  } catch {
    // .env.test doesn't exist, skip test DB setup
  }
  return null;
};

/**
 * Create the test database if it doesn't exist.
 * Connects to the 'postgres' maintenance database to create the new database.
 */
const createTestDbIfNeeded = async (testDbUrl) => {
  try {
    const parsed = new URL(testDbUrl);
    const testDbName = parsed.pathname.slice(1); // Remove leading /
    
    // Connect to the postgres maintenance database
    parsed.pathname = '/postgres';
    const maintenanceUrl = parsed.toString();
    
    const client = new Client({ connectionString: maintenanceUrl });
    await client.connect();
    
    // Check if database exists
    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [testDbName]
    );
    
    if (result.rows.length === 0) {
      log(`Creating test database: ${testDbName}...`);
      await client.query(`CREATE DATABASE "${testDbName}"`);
      log(`Test database ${testDbName} created.`);
    } else {
      log(`Test database ${testDbName} already exists.`);
    }
    
    await client.end().catch(() => undefined);
    return true;
  } catch (error) {
    log(`Warning: Could not create test database: ${error.message}`);
    return false;
  }
};

/**
 * Drop and recreate the test database schema, then run migrations.
 */
const setupTestDatabase = async (testDbUrl) => {
  log('Setting up test database...');
  
  // Create the database if it doesn't exist
  const created = await createTestDbIfNeeded(testDbUrl);
  if (!created) {
    log('Skipping test database setup.');
    return;
  }
  
  // Drop and recreate schema
  const client = new Client({ connectionString: testDbUrl });
  try {
    await client.connect();
    log('Dropping and recreating test database schema...');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE;');
    await client.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await client.query('CREATE SCHEMA public;');
    await client.query('GRANT ALL ON SCHEMA public TO public;');
    await client.end().catch(() => undefined);
  } catch (error) {
    await client.end().catch(() => undefined);
    log(`Warning: Test database schema reset failed: ${error.message}`);
    return;
  }
  
  // Run migrations on test database
  log('Running migrations on test database...');
  const env = {
    ...process.env,
    DATABASE_URL: testDbUrl,
    DB_URL: testDbUrl,
  };
  const result = spawnSync('npm', ['run', 'db:migrate'], {
    cwd: backendRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  if (result.status !== 0) {
    log('Warning: Test database migrations failed.');
  } else {
    log('Test database setup complete.');
  }
};

const main = async () => {
  try {
    // Reset main database
    await dropAndRecreate();
    runMigrations();
    runSeed();
    log('Database reset complete.');
    
    // Also set up test database if configured
    const testDbUrl = resolveTestDbUrl();
    if (testDbUrl) {
      await setupTestDatabase(testDbUrl);
    }
  } catch (error) {
    fail('Database reset failed.', error);
  }
};

void main();
