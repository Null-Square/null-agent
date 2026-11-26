/**
 * SeedRunner - Orchestrates seeding with explicit dependency ordering.
 * 
 * Ensures entities are seeded in the correct order to satisfy foreign key
 * constraints and logical dependencies.
 * 
 * Tracks applied seeds in DB to prevent re-running (industry standard pattern).
 * Uses file hash comparison to detect when seed files have changed.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@/shared/logger';
import { seedStatusRepository } from './SeedStatusRepository';

export interface SeedStep {
    /** Unique name for this seed step */
    name: string;
    /** The seed function to execute */
    seed: () => Promise<void>;
    /** Names of steps that must complete before this one */
    dependsOn?: string[];
    /** Whether this step is required (default: true) */
    required?: boolean;
    /** Path to the seed file (relative to config/seeds/) for version tracking */
    seedFile?: string;
    /**
     * Run whenever the seeder is invoked, even if the seed status hash is
     * unchanged. Use this for seeds whose effective input includes environment
     * values that are intentionally not part of the tracked seed file.
     */
    alwaysRun?: boolean;
}

function collectFilesRecursive(targetPath: string): string[] {
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) {
        return [targetPath];
    }

    if (!stat.isDirectory()) {
        return [];
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFilesRecursive(fullPath));
        } else if (entry.isFile()) {
            files.push(fullPath);
        }
    }
    return files;
}

/**
 * Compute SHA256 hash of a seed file or directory (first 16 chars).
 * For directories, hashes path + content of every file recursively.
 */
export function hashSeedPath(seedPath: string): string | undefined {
    try {
        const fullPath = path.resolve(__dirname, '../../../config/seeds', seedPath);
        const files = collectFilesRecursive(fullPath)
            .map((f) => path.resolve(f))
            .sort((a, b) => a.localeCompare(b));

        if (files.length === 0) {
            return undefined;
        }

        const hash = createHash('sha256');
        for (const file of files) {
            const relative = path.relative(fullPath, file).replace(/\\/g, '/');
            hash.update(relative);
            hash.update('\n');
            hash.update(fs.readFileSync(file));
            hash.update('\n');
        }
        return hash.digest('hex').slice(0, 16);
    } catch {
        return undefined;
    }
}

export interface SeedRunnerOptions {
    /** Enable verbose logging */
    verbose?: boolean;
    /** Dry run - validate but don't execute */
    dryRun?: boolean;
    /** Only run specific steps (by name) */
    only?: string[];
    /** Skip specific steps (by name) */
    skip?: string[];
    /** Only run seeds that haven't been applied yet (default: true in production) */
    checkOnlyPending?: boolean;
    /** Force re-run even if already applied */
    force?: boolean;
}

export interface SeedResult {
    step: string;
    success: boolean;
    durationMs: number;
    error?: Error;
    skipped?: boolean;  // true if seed was already applied
}

export class SeedRunner {
    private readonly steps: SeedStep[];
    private readonly options: SeedRunnerOptions;

    constructor(steps: SeedStep[], options: SeedRunnerOptions = {}) {
        this.steps = steps;
        this.options = options;
        this.validateDependencies();
    }

    /**
     * Run all seed steps in dependency order.
     * Only runs pending seeds unless force=true.
     */
    async runAll(): Promise<SeedResult[]> {
        const results: SeedResult[] = [];
        const completed = new Set<string>();
        const ordered = this.topologicalSort();
        const checkPending = this.options.checkOnlyPending !== false; // default true

        for (const step of ordered) {
            // Check skip/only filters
            if (this.options.skip?.includes(step.name)) {
                this.log(`[seed] Skipping: ${step.name}`);
                continue;
            }
            if (this.options.only && !this.options.only.includes(step.name)) {
                this.log(`[seed] Skipping (not in --only): ${step.name}`);
                continue;
            }

            // Check if seed already applied (unless force mode)
            if (checkPending && !this.options.force && !step.alwaysRun) {
                const seedInfo =
                    (await seedStatusRepository.getInfo(step.name)) ??
                    { name: step.name, applied: false };
                const currentHash = step.seedFile ? hashSeedPath(step.seedFile) : undefined;
                
                // Skip if:
                // 1. Already applied AND
                // 2. No seedFile (legacy) OR hash unchanged
                if (seedInfo.applied) {
                    const hashUnchanged = !currentHash || currentHash === seedInfo.version;
                    if (hashUnchanged) {
                        this.log(`[seed] Already applied, skipping: ${step.name}`);
                        results.push({
                            step: step.name,
                            success: true,
                            durationMs: 0,
                            skipped: true,
                        });
                        completed.add(step.name);
                        continue;
                    } else {
                        this.log(`[seed] File changed, re-running: ${step.name} (${seedInfo.version} -> ${currentHash})`);
                    }
                }
            } else if (checkPending && !this.options.force && step.alwaysRun) {
                this.log(`[seed] alwaysRun enabled, running: ${step.name}`);
            }

            // Verify dependencies are met
            for (const dep of step.dependsOn ?? []) {
                const dependencyExplicitlySkipped = this.options.skip?.includes(dep) ?? false;
                const dependencyExcludedByOnly = this.options.only ? !this.options.only.includes(dep) : false;
                if (!completed.has(dep) && !dependencyExplicitlySkipped && !dependencyExcludedByOnly) {
                    throw new Error(`Dependency not met: ${step.name} requires ${dep}`);
                }
            }

            const result = await this.runStep(step);
            results.push(result);

            if (result.success) {
                completed.add(step.name);
                // Mark seed as applied with file hash
                const fileHash = step.seedFile ? hashSeedPath(step.seedFile) : undefined;
                await seedStatusRepository.markApplied(step.name, fileHash);
            } else if (step.required !== false) {
                throw new Error(`Required seed step failed: ${step.name}`);
            }
        }

        return results;
    }

    /**
     * Run a single seed step.
     */
    private async runStep(step: SeedStep): Promise<SeedResult> {
        this.log(`[seed] Running: ${step.name}...`);
        const start = Date.now();

        if (this.options.dryRun) {
            this.log(`[seed] (dry run) Would run: ${step.name}`);
            return {
                step: step.name,
                success: true,
                durationMs: Date.now() - start,
            };
        }

        try {
            await step.seed();
            const durationMs = Date.now() - start;
            this.log(`[seed] OK ${step.name} (${durationMs}ms)`);
            return { step: step.name, success: true, durationMs };
        } catch (error) {
            const durationMs = Date.now() - start;
            logger.error({ err: error, step: step.name }, `[seed] FAIL ${step.name}`);
            return {
                step: step.name,
                success: false,
                durationMs,
                error: error as Error,
            };
        }
    }

    /**
     * Topological sort to determine execution order.
     */
    private topologicalSort(): SeedStep[] {
        const visited = new Set<string>();
        const result: SeedStep[] = [];
        const stepMap = new Map(this.steps.map(s => [s.name, s]));

        const visit = (name: string) => {
            if (visited.has(name)) return;
            visited.add(name);

            const step = stepMap.get(name);
            if (!step) return;

            for (const dep of step.dependsOn ?? []) {
                visit(dep);
            }
            result.push(step);
        };

        for (const step of this.steps) {
            visit(step.name);
        }

        return result;
    }

    /**
     * Validate that all dependencies exist.
     */
    private validateDependencies(): void {
        const stepNames = new Set(this.steps.map(s => s.name));

        for (const step of this.steps) {
            for (const dep of step.dependsOn ?? []) {
                if (!stepNames.has(dep)) {
                    throw new Error(`Invalid dependency: ${step.name} depends on unknown step ${dep}`);
                }
            }
        }

        // Check for circular dependencies
        this.detectCycles();
    }

    /**
     * Detect circular dependencies using DFS.
     */
    private detectCycles(): void {
        const visited = new Set<string>();
        const inStack = new Set<string>();
        const stepMap = new Map(this.steps.map(s => [s.name, s]));

        const dfs = (name: string, path: string[] = []): void => {
            if (inStack.has(name)) {
                throw new Error(`Circular dependency detected: ${[...path, name].join(' -> ')}`);
            }
            if (visited.has(name)) return;

            inStack.add(name);
            const step = stepMap.get(name);

            if (step) {
                for (const dep of step.dependsOn ?? []) {
                    dfs(dep, [...path, name]);
                }
            }

            inStack.delete(name);
            visited.add(name);
        };

        for (const step of this.steps) {
            dfs(step.name);
        }
    }

    /**
     * Log with verbosity check.
     */
    private log(message: string): void {
        if (this.options.verbose) {
            console.log(message);
        } else {
            logger.info(message);
        }
    }

    /**
     * Print summary of results.
     */
    static printSummary(results: SeedResult[]): void {
        console.log('\n[seed] Summary:');
        console.log('-'.repeat(50));

        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

        for (const result of results) {
            const status = result.success ? 'OK' : 'FAIL';
            console.log(`  ${status} ${result.step} (${result.durationMs}ms)`);
        }

        console.log('-'.repeat(50));
        console.log(`  Total: ${results.length} steps, ${successful.length} passed, ${failed.length} failed (${totalMs}ms)`);

        if (failed.length > 0) {
            console.log('\nFailed steps:');
            for (const f of failed) {
                console.log(`  - ${f.step}: ${f.error?.message ?? 'Unknown error'}`);
            }
        }
    }
}
