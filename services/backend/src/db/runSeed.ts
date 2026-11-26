/**
 * Production Database Seeder
 * 
 * This script seeds essential data after migrations.
 * Designed to run in production Docker containers.
 * Uses seed status tracking - only runs pending seeds.
 * 
 * Usage:
 *   node dist/db/runSeed.js
 *   
 * Environment:
 *   DATABASE_URL - PostgreSQL connection string
 *   SKIP_SEED    - Set to "true" to skip seeding
 *   FORCE_SEED   - Set to "true" to re-run all seeds
 *   SEED_INCLUDE_OPTIONAL - Set to "true" to include optional seeds
 * CLI:
 *   --verbose, --force, --include-optional
 */

import { SeedRunner } from '../app/seeding/SeedRunner';
import { getSeedSteps } from '../app/seeding/seedSteps';

const cliArgs = new Set(process.argv.slice(2));

// Optional seeds are excluded from production bootstrap by default.
const includeOptional =
  process.env.SEED_INCLUDE_OPTIONAL === 'true' || cliArgs.has('--include-optional');
const PRODUCTION_SEED_STEPS = getSeedSteps({ includeOptional });

async function runSeed(): Promise<void> {
  if (process.env.SKIP_SEED === 'true') {
    console.log('[Seed] Skipping seed (SKIP_SEED=true)');
    return;
  }

  console.log('[Seed] Starting production seed...');
  
  const runner = new SeedRunner(PRODUCTION_SEED_STEPS, {
    verbose: process.env.SEED_VERBOSE === 'true' || cliArgs.has('--verbose'),
    force: process.env.FORCE_SEED === 'true' || cliArgs.has('--force'),
  });

  try {
    const results = await runner.runAll();
    
    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      console.error('[Seed] Some seed steps failed:');
      for (const f of failed) {
        console.error(`  - ${f.step}: ${f.error?.message ?? 'Unknown error'}`);
      }
      process.exit(1);
    }
    
    console.log(`[Seed] Completed successfully (${results.length} steps)`);
  } catch (error) {
    console.error('[Seed] Fatal error:', error);
    process.exit(1);
  }
}

runSeed();
