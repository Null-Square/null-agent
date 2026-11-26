import type { SessionState } from '../../domain/types';
import { logger as appLogger } from '@/shared/logger';

/**
 * Port interface for session cleanup operations.
 * SessionStore will implement this.
 */
export interface CleanupSessionPort {
    /** Iterator over all sessions */
    entries(): IterableIterator<[string, SessionState]>;
    /** Remove a session by ID with reason */
    remove(sessionId: string, reason: 'explicit' | 'ttl'): boolean;
}

export interface SessionCleanupOptions {
    /** Session TTL in milliseconds */
    sessionTTL: number;
    /** Statuses that are exempt from TTL cleanup - OBSOLETE, cleanup now uses isProcessing */
    exemptStatuses?: string[];
}

/**
 * SessionCleanupService manages TTL-based session cleanup.
 * 
 * Extracted from SessionStore to reduce file size and provide focused
 * responsibility for session lifecycle management.
 * 
 * Usage:
 * - Call `start()` on service initialization
 * - Call `shutdown()` on service termination
 * - `cleanupExpiredSessions()` runs automatically on interval
 */
export class SessionCleanupService {
    private readonly logger = appLogger.child({ scope: 'SessionCleanupService' });
    private cleanupInterval?: NodeJS.Timeout;
    private readonly sessionTTL: number;
    private readonly exemptStatuses: Set<string>;

    /**
     * Default statuses that should not be cleaned up by TTL.
     * OBSOLETE: No longer used - cleanup now checks isProcessing flag
     */
    private static readonly DEFAULT_EXEMPT_STATUSES: string[] = ['awaiting_user'];

    constructor(
        private readonly sessionPort: CleanupSessionPort,
        options: SessionCleanupOptions,
    ) {
        this.sessionTTL = options.sessionTTL;
        this.exemptStatuses = new Set(
            options.exemptStatuses ?? SessionCleanupService.DEFAULT_EXEMPT_STATUSES
        );
    }

    /**
     * Start the cleanup loop timer.
     * The interval is set to half the TTL or 30 minutes, whichever is smaller.
     * Minimum interval is 1 minute.
     */
    start(): void {
        if (this.cleanupInterval) {
            return; // Already running
        }

        const intervalMs = Math.max(
            Math.min(Math.floor(this.sessionTTL / 2), 30 * 60 * 1000),
            60 * 1000
        );

        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredSessions();
        }, intervalMs);

        // Allow process to exit even if timer is running
        this.cleanupInterval.unref?.();

        this.logger.debug({ intervalMs }, 'Cleanup loop started');
    }

    /**
     * Stop the cleanup loop timer.
     */
    shutdown(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
            this.logger.debug('Cleanup loop stopped');
        }
    }

    /**
     * Run a single cleanup pass, removing expired sessions.
     * 
     * @returns Object with count of removed sessions and their IDs
     */
    cleanupExpiredSessions(): { removed: number; sessionIds: string[] } {
        const now = Date.now();
        const removedIds: string[] = [];

        for (const [id, session] of this.sessionPort.entries()) {
            // Skip sessions with pending approvals or actively processing
            // Use stateMachine as source of truth for processing state
            const isProcessing = session.stateMachine?.isProcessing() ?? false;
            if (isProcessing || session.pendingApproval) {
                continue;
            }

            if (now - session.lastActive > this.sessionTTL) {
                this.sessionPort.remove(id, 'ttl');
                removedIds.push(id);
            }
        }

        if (removedIds.length > 0) {
            this.logger.info(
                { removed: removedIds.length, sessionIds: removedIds },
                'Cleaned up expired sessions'
            );
        }

        return { removed: removedIds.length, sessionIds: removedIds };
    }

    /**
     * Check if the cleanup loop is currently running.
     */
    isRunning(): boolean {
        return this.cleanupInterval !== undefined;
    }

    /**
     * Get the current session TTL.
     */
    getSessionTTL(): number {
        return this.sessionTTL;
    }
}
