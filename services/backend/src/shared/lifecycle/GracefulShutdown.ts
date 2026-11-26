import { type Server } from 'http';
import type { Socket } from 'net';
import { logger as appLogger } from '@/shared/logger';
import { circuitBreakerRegistry } from '@/domains/agent-brain/application/services/CircuitBreaker';
import { GRACEFUL_SHUTDOWN_MS } from '@/config/timeouts';

/**
 * Graceful shutdown configuration.
 */
export interface GracefulShutdownConfig {
    /** Timeout before forcing shutdown (ms). Default: 30000 */
    timeoutMs?: number;
    /** Callback before shutdown starts */
    onShutdownStart?: () => void | Promise<void>;
    /** Callback after HTTP server closes */
    onServerClosed?: () => void | Promise<void>;
    /** Additional cleanup functions to run */
    cleanupHandlers?: Array<() => void | Promise<void>>;
    /** Optional exit function (primarily for tests) */
    exitFn?: (code?: number) => void;
}

/**
 * GracefulShutdown handles clean server termination:
 * - Stops accepting new connections
 * - Waits for in-flight requests to complete
 * - Runs cleanup handlers
 * - Force exits after timeout
 * 
 * @example
 * ```typescript
 * const server = app.listen(3000);
 * const shutdown = new GracefulShutdown(server, {
 *   timeoutMs: 30000,
 *   cleanupHandlers: [
 *     () => redis.quit(),
 *     () => sessionStore.shutdown(),
 *   ],
 * });
 * shutdown.register();
 * ```
 */
export class GracefulShutdown {
    private readonly server: Server;
    private readonly timeoutMs: number;
    private readonly onShutdownStart?: () => void | Promise<void>;
    private readonly onServerClosed?: () => void | Promise<void>;
    private readonly cleanupHandlers: Array<() => void | Promise<void>>;
    private readonly logger = appLogger.child({ scope: 'GracefulShutdown' });
    private readonly exitFn: (code?: number) => void;
    private isShuttingDown = false;
    private connections = new Set<Socket>();

    constructor(server: Server, config: GracefulShutdownConfig = {}) {
        this.server = server;
        this.timeoutMs = config.timeoutMs ?? GRACEFUL_SHUTDOWN_MS;
        this.onShutdownStart = config.onShutdownStart;
        this.onServerClosed = config.onServerClosed;
        this.cleanupHandlers = config.cleanupHandlers ?? [];
        this.exitFn = config.exitFn ?? process.exit;
    }

    /**
     * Register signal handlers and connection tracking.
     */
    register(): void {
        // Track connections for force-close on timeout
        this.server.on('connection', (socket) => {
            this.connections.add(socket);
            socket.on('close', () => this.connections.delete(socket));
        });

        // Register signal handlers
        process.on('SIGTERM', () => this.shutdown('SIGTERM'));
        process.on('SIGINT', () => this.shutdown('SIGINT'));

        this.logger.info({ timeoutMs: this.timeoutMs }, 'Graceful shutdown registered');
    }

    /**
     * Initiate graceful shutdown.
     */
    async shutdown(signal: string): Promise<void> {
        if (this.isShuttingDown) {
            this.logger.warn({ signal }, 'Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        this.logger.info({ signal, connections: this.connections.size }, 'Starting graceful shutdown');

        // Set force-exit timeout
        const forceExitTimer = setTimeout(() => {
            this.logger.error({ connections: this.connections.size }, 'Shutdown timeout - forcing exit');
            process.exit(1);
        }, this.timeoutMs);

        try {
            // Notify shutdown start
            await this.onShutdownStart?.();

            // Stop accepting new connections
            await new Promise<void>((resolve, reject) => {
                this.server.close((err) => {
                    if (err) {
                        this.logger.warn({ err }, 'Error closing server');
                        reject(err);
                    } else {
                        this.logger.info('HTTP server closed');
                        resolve();
                    }
                });
            });

            await this.onServerClosed?.();

            // Run cleanup handlers
            for (const handler of this.cleanupHandlers) {
                try {
                    await handler();
                } catch (err) {
                    this.logger.warn({ err }, 'Cleanup handler failed');
                }
            }

            // Shutdown circuit breakers
            circuitBreakerRegistry.shutdown();

            clearTimeout(forceExitTimer);
            this.logger.info('Graceful shutdown complete');
            this.exitFn(0);
        } catch (err) {
            this.logger.error({ err }, 'Shutdown failed');
            clearTimeout(forceExitTimer);
            this.exitFn(1);
        }
    }

    /**
     * Get current shutdown state.
     */
    isInProgress(): boolean {
        return this.isShuttingDown;
    }

    /**
     * Get active connection count.
     */
    getConnectionCount(): number {
        return this.connections.size;
    }
}
