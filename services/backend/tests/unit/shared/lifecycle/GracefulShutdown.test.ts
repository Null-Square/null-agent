import { vi, describe, it, expect, beforeEach, afterEach, Mock } from 'vitest';
import { EventEmitter } from 'events';
import { GracefulShutdown } from '@/shared/lifecycle/GracefulShutdown';

// Mock logger
vi.mock('@/shared/logger', () => ({
    logger: {
        child: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// Mock circuit breaker registry
vi.mock('@/domains/agent-brain/application/services/CircuitBreaker', () => ({
    circuitBreakerRegistry: {
        shutdown: vi.fn(),
    },
}));

describe('GracefulShutdown', () => {
    let mockServer: any;
    let shutdown: GracefulShutdown;
    let exitFn: Mock<(code?: number) => void>;

    beforeEach(() => {
        mockServer = new EventEmitter();
        mockServer.close = vi.fn((cb) => cb());
        exitFn = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
        // Clean up any signal handlers to prevent leaks
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGINT');
    });

    describe('register', () => {
        it('should track connections', () => {
            shutdown = new GracefulShutdown(mockServer, { exitFn });
            shutdown.register();

            const mockSocket = new EventEmitter() as any;
            mockServer.emit('connection', mockSocket);

            expect(shutdown.getConnectionCount()).toBe(1);

            mockSocket.emit('close');
            expect(shutdown.getConnectionCount()).toBe(0);
        });
    });

    describe('shutdown', () => {
        it('should close server and run cleanup', async () => {
            const cleanup = vi.fn();
            shutdown = new GracefulShutdown(mockServer, {
                cleanupHandlers: [cleanup],
                timeoutMs: 5000,
                exitFn,
            });

            await shutdown.shutdown('SIGTERM');

            expect(mockServer.close).toHaveBeenCalled();
            expect(cleanup).toHaveBeenCalled();
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        it('should call onShutdownStart callback', async () => {
            const onStart = vi.fn();
            shutdown = new GracefulShutdown(mockServer, {
                onShutdownStart: onStart,
                exitFn,
            });

            await shutdown.shutdown('SIGINT');

            expect(onStart).toHaveBeenCalled();
        });

        it('should call onServerClosed callback', async () => {
            const onClosed = vi.fn();
            shutdown = new GracefulShutdown(mockServer, {
                onServerClosed: onClosed,
                exitFn,
            });

            await shutdown.shutdown('SIGTERM');

            expect(onClosed).toHaveBeenCalled();
        });

        it('should prevent duplicate shutdown', async () => {
            shutdown = new GracefulShutdown(mockServer, { exitFn });

            // First shutdown
            await shutdown.shutdown('SIGTERM');
            exitFn.mockClear();

            // Second call should be ignored
            await shutdown.shutdown('SIGINT');

            expect(exitFn).not.toHaveBeenCalled();
        });

        it('should handle cleanup handler errors', async () => {
            const failingHandler = vi.fn().mockRejectedValue(new Error('Cleanup failed'));
            const successHandler = vi.fn();

            shutdown = new GracefulShutdown(mockServer, {
                cleanupHandlers: [failingHandler, successHandler],
                exitFn,
            });

            await shutdown.shutdown('SIGTERM');

            expect(failingHandler).toHaveBeenCalled();
            expect(successHandler).toHaveBeenCalled();
            expect(exitFn).toHaveBeenCalledWith(0);
        });

        it('should exit with code 1 when server close fails', async () => {
            mockServer.close = vi.fn((cb) => cb(new Error('close failed')));
            shutdown = new GracefulShutdown(mockServer, { exitFn });

            await shutdown.shutdown('SIGTERM');

            expect(exitFn).toHaveBeenCalledWith(1);
        });
    });

    describe('isInProgress', () => {
        it('should return false initially', () => {
            shutdown = new GracefulShutdown(mockServer, { exitFn });
            expect(shutdown.isInProgress()).toBe(false);
        });

        it('should return true during shutdown', async () => {
            shutdown = new GracefulShutdown(mockServer, { exitFn });

            // Don't await - check mid-shutdown
            const promise = shutdown.shutdown('SIGTERM');
            expect(shutdown.isInProgress()).toBe(true);

            await promise;
        });
    });
});







