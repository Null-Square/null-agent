import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { CheckpointStoreService, CheckpointSessionPort } from '@/domains/agent-brain/application/services/CheckpointStoreService';
import type { SessionState, CheckpointMetadata } from '@/domains/agent-brain/domain/types';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

// =============================================================================
// Mock Factories
// =============================================================================

function createMockCheckpointPort(sessions: Map<string, SessionState> = new Map()): CheckpointSessionPort & {
    persistedCheckpoints: Array<{ sessionId: string; metadata: CheckpointMetadata }>;
} {
    const persistedCheckpoints: Array<{ sessionId: string; metadata: CheckpointMetadata }> = [];

    return {
        get: (id: string) => sessions.get(id),
        updateCheckpoint: async (sessionId: string, checkpointId: string, checkpoint: CheckpointMetadata) => {
            const session = sessions.get(sessionId);
            if (!session) return false;
            session.checkpoints[checkpointId] = checkpoint;
            session.lastCheckpoint = checkpoint;
            return true;
        },
        updateLastCheckpoint: async (sessionId: string, checkpointId: string) => {
            const session = sessions.get(sessionId);
            if (!session) return undefined;
            const checkpoint = session.checkpoints[checkpointId];
            if (!checkpoint) return undefined;
            session.lastCheckpoint = checkpoint;
            return checkpoint;
        },
        queuePersistCheckpoint: (sessionId: string, metadata: CheckpointMetadata) => {
            persistedCheckpoints.push({ sessionId, metadata });
        },
        persistedCheckpoints,
    };
}

function createTestSession(overrides: Partial<SessionState> = {}): SessionState {
    return {
        id: 'test-session',
        status: 'idle',
        mode: 'interactive',
        turn: 0,
        messages: [],
        plan: [],
        memory: createEmptyMemory(),
        pendingApproval: undefined,
        checkpoints: {},
        flags: {},
        createdAt: Date.now(),
        lastActive: Date.now(),
        ...overrides,
    } as SessionState;
}

function createTestCheckpoint(overrides: Partial<CheckpointMetadata> = {}): CheckpointMetadata {
    return {
        id: 'cp-1',
        ts: new Date().toISOString(),
        filesCount: 10,
        sizeBytes: 1024,
        ...overrides,
    };
}

// =============================================================================
// Tests
// =============================================================================

describe('CheckpointStoreService', () => {
    describe('getCheckpoint', () => {
        it('should return checkpoint by ID', () => {
            const sessions = new Map<string, SessionState>();
            const checkpoint = createTestCheckpoint({ id: 'cp-1' });
            sessions.set('s1', createTestSession({
                checkpoints: { 'cp-1': checkpoint },
            }));

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));
            const result = service.getCheckpoint('s1', 'cp-1');

            expect(result).toEqual(checkpoint);
        });

        it('should return undefined for non-existent session', () => {
            const sessions = new Map<string, SessionState>();
            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getCheckpoint('nonexistent', 'cp-1')).toBeUndefined();
        });

        it('should return undefined for non-existent checkpoint', () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getCheckpoint('s1', 'nonexistent')).toBeUndefined();
        });
    });

    describe('listCheckpoints', () => {
        it('should return empty array for non-existent session', () => {
            const sessions = new Map<string, SessionState>();
            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.listCheckpoints('nonexistent')).toEqual([]);
        });

        it('should return checkpoints sorted by timestamp descending', () => {
            const sessions = new Map<string, SessionState>();
            // Use ISO strings that maintain sort order
            const cp1 = createTestCheckpoint({ id: 'cp-1', ts: '2024-01-01T00:00:00Z' });
            const cp2 = createTestCheckpoint({ id: 'cp-2', ts: '2024-01-03T00:00:00Z' });
            const cp3 = createTestCheckpoint({ id: 'cp-3', ts: '2024-01-02T00:00:00Z' });

            sessions.set('s1', createTestSession({
                checkpoints: { 'cp-1': cp1, 'cp-2': cp2, 'cp-3': cp3 },
            }));

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));
            const result = service.listCheckpoints('s1');

            expect(result).toHaveLength(3);
            expect(result[0].id).toBe('cp-2'); // Jan 3 (newest)
            expect(result[1].id).toBe('cp-3'); // Jan 2
            expect(result[2].id).toBe('cp-1'); // Jan 1 (oldest)
        });

        it('should return empty array for session with no checkpoints', () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.listCheckpoints('s1')).toEqual([]);
        });
    });

    describe('addCheckpoint', () => {
        it('should add checkpoint to session', async () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const port = createMockCheckpointPort(sessions);
            const service = new CheckpointStoreService(port);
            const checkpoint = createTestCheckpoint({ id: 'new-cp' });

            const result = await service.addCheckpoint('s1', checkpoint);

            expect(result).toBe(true);
            expect(sessions.get('s1')!.checkpoints['new-cp']).toEqual(checkpoint);
        });

        it('should queue persistence for checkpoint', async () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const port = createMockCheckpointPort(sessions);
            const service = new CheckpointStoreService(port);
            const checkpoint = createTestCheckpoint({ id: 'new-cp' });

            await service.addCheckpoint('s1', checkpoint);

            expect(port.persistedCheckpoints).toHaveLength(1);
            expect(port.persistedCheckpoints[0].sessionId).toBe('s1');
            expect(port.persistedCheckpoints[0].metadata).toEqual(checkpoint);
        });

        it('should return false for non-existent session', async () => {
            const sessions = new Map<string, SessionState>();
            const port = createMockCheckpointPort(sessions);
            const service = new CheckpointStoreService(port);

            const result = await service.addCheckpoint('nonexistent', createTestCheckpoint());

            expect(result).toBe(false);
            expect(port.persistedCheckpoints).toHaveLength(0);
        });

        it('should update lastCheckpoint when adding', async () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const port = createMockCheckpointPort(sessions);
            const service = new CheckpointStoreService(port);
            const checkpoint = createTestCheckpoint({ id: 'new-cp' });

            await service.addCheckpoint('s1', checkpoint);

            expect(sessions.get('s1')!.lastCheckpoint).toEqual(checkpoint);
        });
    });

    describe('updateLastCheckpoint', () => {
        it('should update lastCheckpoint pointer', async () => {
            const sessions = new Map<string, SessionState>();
            const cp1 = createTestCheckpoint({ id: 'cp-1' });
            const cp2 = createTestCheckpoint({ id: 'cp-2' });
            sessions.set('s1', createTestSession({
                checkpoints: { 'cp-1': cp1, 'cp-2': cp2 },
                lastCheckpoint: cp1,
            }));

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));
            const result = await service.updateLastCheckpoint('s1', 'cp-2');

            expect(result).toEqual(cp2);
            expect(sessions.get('s1')!.lastCheckpoint).toEqual(cp2);
        });

        it('should return undefined for non-existent session', async () => {
            const sessions = new Map<string, SessionState>();
            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            const result = await service.updateLastCheckpoint('nonexistent', 'cp-1');

            expect(result).toBeUndefined();
        });

        it('should return undefined for non-existent checkpoint', async () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));
            const result = await service.updateLastCheckpoint('s1', 'nonexistent');

            expect(result).toBeUndefined();
        });
    });

    describe('getLastCheckpoint', () => {
        it('should return lastCheckpoint', () => {
            const sessions = new Map<string, SessionState>();
            const checkpoint = createTestCheckpoint({ id: 'cp-1' });
            sessions.set('s1', createTestSession({
                checkpoints: { 'cp-1': checkpoint },
                lastCheckpoint: checkpoint,
            }));

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getLastCheckpoint('s1')).toEqual(checkpoint);
        });

        it('should return undefined when no lastCheckpoint', () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getLastCheckpoint('s1')).toBeUndefined();
        });
    });

    describe('getCheckpointCount', () => {
        it('should return count of checkpoints', () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession({
                checkpoints: {
                    'cp-1': createTestCheckpoint({ id: 'cp-1' }),
                    'cp-2': createTestCheckpoint({ id: 'cp-2' }),
                    'cp-3': createTestCheckpoint({ id: 'cp-3' }),
                },
            }));

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getCheckpointCount('s1')).toBe(3);
        });

        it('should return 0 for session with no checkpoints', () => {
            const sessions = new Map<string, SessionState>();
            sessions.set('s1', createTestSession());

            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getCheckpointCount('s1')).toBe(0);
        });

        it('should return 0 for non-existent session', () => {
            const sessions = new Map<string, SessionState>();
            const service = new CheckpointStoreService(createMockCheckpointPort(sessions));

            expect(service.getCheckpointCount('nonexistent')).toBe(0);
        });
    });
});







