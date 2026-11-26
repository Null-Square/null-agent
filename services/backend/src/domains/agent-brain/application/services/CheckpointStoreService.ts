import type { SessionState, CheckpointMetadata } from '../../domain/types';
import { logger as appLogger } from '@/shared/logger';

/**
 * Port interface for checkpoint operations.
 * SessionStore will implement this to bridge the checkpoint service with session state.
 */
export interface CheckpointSessionPort {
    /** Get a session by ID */
    get(sessionId: string): SessionState | undefined;
    /** Update session checkpoint map */
    updateCheckpoint(
        sessionId: string,
        checkpointId: string,
        checkpoint: CheckpointMetadata
    ): Promise<boolean>;
    /** Update last checkpoint pointer */
    updateLastCheckpoint(sessionId: string, checkpointId: string): Promise<CheckpointMetadata | undefined>;
    /** Queue persistence for checkpoint */
    queuePersistCheckpoint(sessionId: string, metadata: CheckpointMetadata): void;
}

/**
 * CheckpointStoreService manages session checkpoint metadata.
 * 
 * Extracted from SessionStore to provide focused checkpoint management.
 * Checkpoints are snapshots of session state for recovery/rollback.
 * 
 * Read operations are synchronous (direct session access).
 * Write operations delegate to the port for async handling.
 */
export class CheckpointStoreService {
    private readonly logger = appLogger.child({ scope: 'CheckpointStoreService' });

    constructor(
        private readonly sessionPort: CheckpointSessionPort,
    ) { }

    /**
     * Get a specific checkpoint by ID.
     * 
     * @param sessionId Session to look up
     * @param checkpointId Checkpoint to retrieve
     * @returns Checkpoint metadata or undefined if not found
     */
    getCheckpoint(sessionId: string, checkpointId: string): CheckpointMetadata | undefined {
        const session = this.sessionPort.get(sessionId);
        if (!session) return undefined;
        return session.checkpoints[checkpointId];
    }

    /**
     * List all checkpoints for a session, sorted by timestamp (newest first).
     * 
     * @param sessionId Session to list checkpoints for
     * @returns Array of checkpoint metadata, sorted descending by timestamp
     */
    listCheckpoints(sessionId: string): CheckpointMetadata[] {
        const session = this.sessionPort.get(sessionId);
        if (!session) return [];
        return Object.values(session.checkpoints).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    }

    /**
     * Add a new checkpoint to a session.
     * 
     * @param sessionId Session to add checkpoint to
     * @param metadata Checkpoint metadata to store
     * @returns True if checkpoint was added
     */
    async addCheckpoint(sessionId: string, metadata: CheckpointMetadata): Promise<boolean> {
        const result = await this.sessionPort.updateCheckpoint(sessionId, metadata.id, metadata);
        if (result) {
            this.sessionPort.queuePersistCheckpoint(sessionId, metadata);
        }
        return result;
    }

    /**
     * Update the last checkpoint pointer for a session.
     * 
     * @param sessionId Session to update
     * @param checkpointId ID of checkpoint to set as last
     * @returns The checkpoint metadata if found and updated, undefined otherwise
     */
    async updateLastCheckpoint(
        sessionId: string,
        checkpointId: string
    ): Promise<CheckpointMetadata | undefined> {
        return this.sessionPort.updateLastCheckpoint(sessionId, checkpointId);
    }

    /**
     * Get the last checkpoint for a session.
     * 
     * @param sessionId Session to query
     * @returns The last checkpoint metadata or undefined
     */
    getLastCheckpoint(sessionId: string): CheckpointMetadata | undefined {
        const session = this.sessionPort.get(sessionId);
        return session?.lastCheckpoint;
    }

    /**
     * Get the count of checkpoints for a session.
     * 
     * @param sessionId Session to query
     * @returns Number of checkpoints
     */
    getCheckpointCount(sessionId: string): number {
        const session = this.sessionPort.get(sessionId);
        if (!session) return 0;
        return Object.keys(session.checkpoints).length;
    }
}
