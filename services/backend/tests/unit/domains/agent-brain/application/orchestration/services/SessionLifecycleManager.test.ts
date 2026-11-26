import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { SessionLifecycleManager } from '@/domains/agent-brain/application/orchestration/services/SessionLifecycleManager';
import type { SessionLifecycleManagerDeps } from '@/domains/agent-brain/application/orchestration/services/SessionLifecycleManager';
import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SessionEventPublisher } from '@/domains/agent-brain/ports';
import type { SessionState } from '@/domains/agent-brain/domain/types';
import type { TaskPreparation } from '@/domains/agent-brain/domain/types';

// Mock dependencies
const mockSessionStore = {
    set: vi.fn(),
    updatePlan: vi.fn(),
} as unknown as SessionStore;

const mockEvents = {
    emit: vi.fn(),
    emitPlan: vi.fn(),
    cleanup: vi.fn(),
} as unknown as SessionEventPublisher;


describe('SessionLifecycleManager', () => {
    let manager: SessionLifecycleManager;
    let deps: SessionLifecycleManagerDeps;
    let mockSession: SessionState;

    beforeEach(() => {
        deps = {
            sessions: {
                set: vi.fn(),
                updatePlan: vi.fn(),
            } as unknown as SessionStore,
            events: {
                emit: vi.fn(),
                emitPlan: vi.fn(),
                cleanup: vi.fn(),
            } as unknown as SessionEventPublisher,
        };

        manager = new SessionLifecycleManager(deps);

        mockSession = {
            id: 'session-1',
            plan: [],
        } as unknown as SessionState;
    });

    it('should initialize session correctly', async () => {
        const preparation: TaskPreparation = {
            sessionTask: {
                id: 'task-1',
                title: 'Test Task',
                category: 'test',
                summary: 'A test task',
                versionHash: 'hash',
                vars: {},
            },
            plan: [{ id: 'step-1', title: 'Step 1', status: 'pending' }],
            redactedVars: {},
        };

        await manager.initialize(mockSession, preparation);

        expect(deps.sessions.set).toHaveBeenCalledWith('session-1', mockSession);
        expect(deps.sessions.updatePlan).toHaveBeenCalledWith('session-1', preparation.plan);
        expect(deps.events.emitPlan).toHaveBeenCalledWith('session-1', preparation.plan);
        expect(deps.events.emit).toHaveBeenCalledWith('session-1', expect.objectContaining({
            type: 'task_selected',
            data: expect.objectContaining({ id: 'task-1' }),
        }));
    });

    it('should cleanup session correctly', () => {
        manager.cleanup('session-1');
        expect(deps.events.cleanup).toHaveBeenCalledWith('session-1');
    });
});







