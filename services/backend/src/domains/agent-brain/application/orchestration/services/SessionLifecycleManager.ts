import type { SessionState } from '../../../domain/types';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { SessionEventPublisher } from '../../../ports';
import type { TaskPreparation } from '../../../domain/types';
import { type SessionStore } from '../../core/SessionStore';
import { logger } from '@/shared/logger';

export interface SessionLifecycleManagerDeps {
    sessions: SessionStore;
    events: SessionEventPublisher;
}

export class SessionLifecycleManager {
    constructor(private readonly deps: SessionLifecycleManagerDeps) { }
    private readonly log = logger.child({ scope: 'SessionLifecycleManager' });

    async initialize(
        session: SessionState,
        preparation?: TaskPreparation,
        traceRecorder?: SessionTraceRecorder,
    ): Promise<void> {
        this.deps.sessions.set(session.id, session);

        if (preparation?.plan && preparation.plan.length > 0) {
            this.deps.sessions.updatePlan(session.id, preparation.plan);
            this.emitPlan(session.id, preparation.plan);
        }

        await this.emitTaskSelected(session.id, preparation, traceRecorder);
    }

    cleanup(sessionId: string): void {
        this.deps.events.cleanup(sessionId);
    }

    private emitPlan(sessionId: string, plan: TaskPreparation['plan']): void {
        this.deps.events.emitPlan(sessionId, plan);
    }

    private async emitTaskSelected(
        sessionId: string,
        preparation: TaskPreparation | undefined,
        traceRecorder?: SessionTraceRecorder,
    ): Promise<void> {
        if (!preparation?.sessionTask) {
            return;
        }

        const { sessionTask, redactedVars } = preparation;

        if (traceRecorder) {
            try {
                await traceRecorder.write(sessionId, 0, {
                    event: 'task.selected',
                    severity: 'info',
                    payload: {
                        id: sessionTask.id,
                        title: sessionTask.title,
                        versionHash: sessionTask.versionHash,
                        vars: redactedVars,
                    },
                    note: `[${sessionTask.id}] ${sessionTask.title}`,
                });
            } catch (error) {
                this.log.warn({ err: error, sessionId }, 'Failed to record task selection');
            }
        }

        this.deps.events.emit(sessionId, {
            type: 'task_selected',
            data: {
                id: sessionTask.id,
                title: sessionTask.title,
                category: sessionTask.category,
                summary: sessionTask.summary,
                versionHash: sessionTask.versionHash,
                vars: redactedVars,
            },
        });
    }
}
