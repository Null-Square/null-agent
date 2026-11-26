/**
 * Unified Database Seeder
 * 
 * Seeds all entities from manifest files in dependency order.
 * Uses upsert semantics for idempotent runs.
 * Uses hash-based versioning to detect when seed files have changed.
 * 
 * Usage:
 *   npm run db:seed                        # Run default bootstrap seeds
 *   npm run db:seed -- --verbose           # Verbose output
 *   npm run db:seed -- --dry-run           # Validate only, no DB writes
 *   npm run db:seed -- --force             # Force re-run selected seeds
 *   npm run db:seed -- --include-optional  # Include optional seeds when defined
 */
import '../src/config/loadDotenv';
import { SeedRunner, type SeedStep } from '../src/app/seeding/SeedRunner';
import { getSeedSteps } from '../src/app/seeding/seedSteps';

function buildSeedSteps(includeOptional: boolean): SeedStep[] {
    return getSeedSteps({ includeOptional });
}

async function main() {
    // Parse CLI args
    const args = process.argv.slice(2);
    const parseCsvArg = (name: string): string[] | undefined => {
        const raw = args.find(a => a.startsWith(`${name}=`))?.split('=')[1];
        if (!raw) return undefined;
        const values = raw.split(',').map(v => v.trim()).filter(Boolean);
        return values.length > 0 ? values : undefined;
    };

    const verbose = args.includes('--verbose') || args.includes('-v');
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const only = parseCsvArg('--only');
    const skip = parseCsvArg('--skip');
    // Optional seeds stay out of default bootstraps unless explicitly included.
    const includeOptional = args.includes('--include-optional')
      || process.env.SEED_INCLUDE_OPTIONAL === 'true'
      || Boolean(only?.length);

    const seedSteps = buildSeedSteps(includeOptional);

    console.log('[seed] Starting database seeder...');
    console.log(`[seed] Options: verbose=${verbose}, dryRun=${dryRun}, force=${force}, includeOptional=${includeOptional}`);
    if (only) console.log(`[seed] Only running: ${only.join(', ')}`);
    if (skip) console.log(`[seed] Skipping: ${skip.join(', ')}`);
    console.log('');

    const runner = new SeedRunner(seedSteps, { verbose, dryRun, force, only, skip });
    const results = await runner.runAll();

    SeedRunner.printSummary(results);

    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
        process.exit(1);
    }

    console.log('\n[seed] Seeding completed successfully.');
    process.exit(0);
}

main().catch((err) => {
    console.error('[seed] Seeding failed:', err);
    process.exit(1);
});
