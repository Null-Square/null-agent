/**
 * Database Migration Runner
 * 
 * This script runs database migrations before the application starts.
 * It's designed to be called from the Docker entrypoint or manually.
 * 
 * Usage:
 *   node dist/db/runMigrations.js
 *   
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { Pool } from 'pg';

export async function runMigrations(
  migrationsFolder = path.resolve(__dirname, '../../drizzle'),
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    throw new Error('[Migrations] DATABASE_URL is not set');
  }

  console.log('[Migrations] Starting database migrations...');
  console.log(`[Migrations] Folder: ${migrationsFolder}`);
  
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);

  try {
    await migrate(db, { migrationsFolder });
    console.log('[Migrations] Database migrations completed successfully');
  } catch (error) {
    console.error('[Migrations] Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

export default runMigrations;

if (require.main === module) {
  runMigrations().catch(() => {
    process.exit(1);
  });
}
