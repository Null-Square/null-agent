import type { SessionState, SandboxPolicySummary } from '../../../domain/types';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import type { SandboxProvisioningPort, SessionEventPublisher } from '../../../ports';
import { logger } from '@/shared/logger';

export interface SandboxProvisionerDeps {
    provision: SandboxProvisioningPort;
    events: SessionEventPublisher;
}

export class SandboxProvisioner {
    constructor(private readonly deps: SandboxProvisionerDeps) { }
    private readonly log = logger.child({ scope: 'SandboxProvisioner' });

    async provision(
        session: SessionState,
        sandboxImage?: string,
        traceRecorder?: SessionTraceRecorder,
    ): Promise<SandboxPolicySummary | undefined> {
        await this.deps.provision.create(session);

        const policy = await this.deps.provision.getPolicy(session.id);
        if (policy) {
            this.deps.events.emit(session.id, {
                type: 'sandbox_policy',
                data: policy,
            });
        }

        if (traceRecorder && session.containerId) {
            try {
                await traceRecorder.write(session.id, session.turn ?? 0, {
                    event: 'session.sandbox.ready',
                    severity: 'info',
                    payload: {
                        containerId: session.containerId,
                        image: sandboxImage,
                    },
                    note: session.containerId ? `container=${session.containerId}` : 'host workspace',
                });
            } catch (error) {
                this.log.warn({ err: error, sessionId: session.id }, 'Failed to record sandbox readiness');
            }
        }

        return policy;
    }

    async stop(session: SessionState, reason?: string): Promise<void> {
        await this.deps.provision.stop(session, reason);
    }

    async destroy(session: SessionState): Promise<void> {
        await this.deps.provision.destroy(session);
    }

    async getPolicy(sessionId: string): Promise<SandboxPolicySummary | undefined> {
        return this.deps.provision.getPolicy(sessionId);
    }
}
