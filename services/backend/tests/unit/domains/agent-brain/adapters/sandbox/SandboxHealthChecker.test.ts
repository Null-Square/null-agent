import { vi, describe, it, expect, beforeEach, Mock } from 'vitest';
import { SandboxHealthChecker, type SandboxHealthCheckerDeps } from '@/domains/agent-brain/adapters/sandbox';

describe('SandboxHealthChecker', () => {
    let mockDeps: SandboxHealthCheckerDeps;
    let checker: SandboxHealthChecker;

    beforeEach(() => {
        mockDeps = {
            execInContainer: vi.fn(),
            inspectContainer: vi.fn(),
        };
        checker = new SandboxHealthChecker(mockDeps);
    });

    describe('check', () => {
        it('should return healthy when container is running with sufficient disk space', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: true,
                startedAt: new Date().toISOString(),
            });
            (mockDeps.execInContainer as Mock).mockResolvedValue({
                stdout: 'Filesystem  1M-blocks  Used  Available\n/dev/sda1     10000    5000  5000',
                exitCode: 0,
            });

            const result = await checker.check('container-123');

            expect(result.healthy).toBe(true);
            expect(result.containerRunning).toBe(true);
            expect(result.diskSpaceOk).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should return unhealthy when container is not found', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue(null);

            const result = await checker.check('container-123');

            expect(result.healthy).toBe(false);
            expect(result.containerRunning).toBe(false);
            expect(result.errors).toContain('Container not found');
        });

        it('should return unhealthy when container is not running', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: false,
            });

            const result = await checker.check('container-123');

            expect(result.healthy).toBe(false);
            expect(result.containerRunning).toBe(false);
            expect(result.errors).toContain('Container is not running');
        });

        it('should return unhealthy when disk space is low', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: true,
            });
            (mockDeps.execInContainer as Mock).mockResolvedValue({
                stdout: 'Filesystem  1M-blocks  Used  Available\n/dev/sda1     10000    9950  50',
                exitCode: 0,
            });

            const result = await checker.check('container-123');

            expect(result.healthy).toBe(false);
            expect(result.diskSpaceOk).toBe(false);
            expect(result.errors.some(e => e.includes('Low disk space'))).toBe(true);
        });

        it('should calculate uptime correctly', async () => {
            const startedAt = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: true,
                startedAt,
            });
            (mockDeps.execInContainer as Mock).mockResolvedValue({
                stdout: 'Filesystem  1M-blocks  Used  Available\n/dev/sda1     10000    5000  5000',
                exitCode: 0,
            });

            const result = await checker.check('container-123');

            expect(result.uptimeMs).toBeDefined();
            expect(result.uptimeMs).toBeGreaterThanOrEqual(59000);
        });

        it('should handle inspection errors gracefully', async () => {
            (mockDeps.inspectContainer as Mock).mockRejectedValue(new Error('Docker API error'));

            const result = await checker.check('container-123');

            expect(result.healthy).toBe(false);
            expect(result.errors.some(e => e.includes('Container inspection failed'))).toBe(true);
        });

        it('should handle disk check errors gracefully', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: true,
            });
            (mockDeps.execInContainer as Mock).mockRejectedValue(new Error('Exec failed'));

            const result = await checker.check('container-123');

            // Should still work, disk check failure is logged but not blocking
            expect(result.containerRunning).toBe(true);
            expect(result.errors.some(e => e.includes('Disk space check failed'))).toBe(true);
        });
    });

    describe('waitForHealthy', () => {
        it('should return immediately when container is healthy', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: true,
            });
            (mockDeps.execInContainer as Mock).mockResolvedValue({
                stdout: 'Filesystem  1M-blocks  Used  Available\n/dev/sda1     10000    5000  5000',
                exitCode: 0,
            });

            const result = await checker.waitForHealthy('container-123', 5000);

            expect(result.healthy).toBe(true);
            expect(result.attempts).toBe(1);
        });

        it('should poll until healthy', async () => {
            let callCount = 0;
            (mockDeps.inspectContainer as Mock).mockImplementation(async () => {
                callCount++;
                return { running: callCount >= 2 }; // Healthy on second call
            });
            (mockDeps.execInContainer as Mock).mockResolvedValue({
                stdout: 'Filesystem  1M-blocks  Used  Available\n/dev/sda1     10000    5000  5000',
                exitCode: 0,
            });

            const result = await checker.waitForHealthy('container-123', 5000);

            expect(result.healthy).toBe(true);
            expect(result.attempts).toBeGreaterThan(1);
        });

        it('should timeout if container never becomes healthy', async () => {
            (mockDeps.inspectContainer as Mock).mockResolvedValue({
                running: false,
            });

            const result = await checker.waitForHealthy('container-123', 1500);

            expect(result.healthy).toBe(false);
            expect(result.attempts).toBeGreaterThan(0);
        }, 5000);
    });
});







