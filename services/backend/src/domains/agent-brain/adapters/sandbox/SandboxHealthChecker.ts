/**
 * Sandbox Health Checker
 * 
 * Provides health verification for Docker sandbox containers:
 * - Container running status
 * - Disk space availability
 * - Process responsiveness
 */

import { logger } from '@/shared/logger';
import { toSafeError } from '@/shared/errors';
import type { SandboxHealth, SandboxHealthPort } from '../../ports';

export interface SandboxHealthCheckerDeps {
    /** Function to execute command in container */
    execInContainer: (containerId: string, cmd: string[]) => Promise<{ stdout: string; exitCode: number }>;
    /** Function to inspect container status */
    inspectContainer: (containerId: string) => Promise<{ running: boolean; startedAt?: string } | null>;
}

const MIN_DISK_FREE_MB = 100; // Minimum 100MB free disk space
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export class SandboxHealthChecker implements SandboxHealthPort {
    private readonly log = logger.child({ scope: 'SandboxHealthChecker' });

    constructor(private readonly deps: SandboxHealthCheckerDeps) { }

    /**
     * Perform comprehensive health check on a sandbox container
     */
    async check(containerId: string): Promise<SandboxHealth> {
        const checkStarted = Date.now();
        const errors: string[] = [];
        let containerRunning = false;
        let diskSpaceOk = true;
        let uptimeMs: number | undefined;

        // 1. Check container running status
        try {
            const inspection = await this.deps.inspectContainer(containerId);
            if (!inspection) {
                errors.push('Container not found');
            } else {
                containerRunning = inspection.running;
                if (!containerRunning) {
                    errors.push('Container is not running');
                }
                if (inspection.startedAt) {
                    uptimeMs = Date.now() - new Date(inspection.startedAt).getTime();
                }
            }
        } catch (error: unknown) {
            const err = toSafeError(error);
            errors.push(`Container inspection failed: ${err.message}`);
            this.log.warn({ err, containerId }, '[SandboxHealthChecker] Container inspection failed');
        }

        // 2. Check disk space (only if container is running)
        if (containerRunning) {
            try {
                const diskCheck = await this.checkDiskSpace(containerId);
                diskSpaceOk = diskCheck.ok;
                if (!diskSpaceOk) {
                    errors.push(diskCheck.reason ?? 'Disk space low');
                }
            } catch (error: unknown) {
                const err = toSafeError(error);
                errors.push(`Disk space check failed: ${err.message}`);
                this.log.warn({ err, containerId }, '[SandboxHealthChecker] Disk space check failed');
            }
        }

        const healthy = containerRunning && diskSpaceOk && errors.length === 0;

        this.log.debug(
            { containerId, healthy, containerRunning, diskSpaceOk, errors, checkDurationMs: Date.now() - checkStarted },
            '[SandboxHealthChecker] Health check completed',
        );

        return {
            healthy,
            containerId,
            containerRunning,
            diskSpaceOk,
            lastCheckAt: checkStarted,
            errors,
            uptimeMs,
        };
    }

    /**
     * Wait for container to become healthy with timeout
     */
    async waitForHealthy(containerId: string, timeoutMs: number): Promise<{ healthy: boolean; attempts: number }> {
        const startTime = Date.now();
        let attempts = 0;
        const pollIntervalMs = 1000;

        while (Date.now() - startTime < timeoutMs) {
            attempts++;
            const health = await this.check(containerId);
            if (health.healthy) {
                return { healthy: true, attempts };
            }
            await this.sleep(pollIntervalMs);
        }

        this.log.warn(
            { containerId, timeoutMs, attempts },
            '[SandboxHealthChecker] Timeout waiting for healthy container',
        );

        return { healthy: false, attempts };
    }

    /**
     * Check disk space in container
     */
    private async checkDiskSpace(containerId: string): Promise<{ ok: boolean; reason?: string; freeMb?: number }> {
        // Use df command to check disk space in /workspace
        const result = await this.deps.execInContainer(containerId, ['df', '-m', '/workspace']);

        if (result.exitCode !== 0) {
            return { ok: false, reason: 'df command failed' };
        }

        // Parse df output (second line, 4th column is "Available")
        const lines = result.stdout.trim().split('\n');
        if (lines.length < 2) {
            return { ok: true }; // Can't parse, assume OK
        }

        const parts = lines[1].split(/\s+/);
        const availableMb = parseInt(parts[3], 10);

        if (isNaN(availableMb)) {
            return { ok: true }; // Can't parse, assume OK
        }

        if (availableMb < MIN_DISK_FREE_MB) {
            return { ok: false, reason: `Low disk space: ${availableMb}MB free (min: ${MIN_DISK_FREE_MB}MB)`, freeMb: availableMb };
        }

        return { ok: true, freeMb: availableMb };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * Factory function to create SandboxHealthChecker with Docker driver
 */
export function createSandboxHealthChecker(dockerDriver: {
    exec: (containerId: string, cmd: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
    inspect: (containerId: string) => Promise<unknown>;
}): SandboxHealthChecker {
    return new SandboxHealthChecker({
        execInContainer: async (containerId, cmd) => {
            const result = await dockerDriver.exec(containerId, cmd);
            return { stdout: result.stdout, exitCode: result.exitCode };
        },
        inspectContainer: async (containerId) => {
            try {
                const inspection = await dockerDriver.inspect(containerId);
                const state = isRecord(inspection) ? inspection['State'] : undefined;
                const stateRecord = isRecord(state) ? state : undefined;
                return {
                    running: typeof stateRecord?.['Running'] === 'boolean' ? stateRecord['Running'] : false,
                    startedAt: typeof stateRecord?.['StartedAt'] === 'string' ? stateRecord['StartedAt'] : undefined,
                };
            } catch {
                return null;
            }
        },
    });
}
