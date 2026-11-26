import { type SidecarRunner, type SidecarOptions } from './SidecarRunner';
import { type SessionState } from '../../domain/types';
import { resolveCapabilityProfile, type ResolvedCapabilityProfile } from './capabilityProfiles';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import type { PolicyResolver } from '../../domain/policy';
import { type PolicyEngine } from '../../application/services/PolicyEngine';
import { buildAdmissionRuntimeLabels, readCloudAdmissionRuntimeOwnership } from './runtimeOwnership';

// summarizeForNote imported from @/shared/utils/text

export class SidecarManager {
    private readonly sidecars = new Map<string, Set<string>>();
    private readonly log = logger.child({ scope: 'SidecarManager' });
    private readonly policyResolver?: PolicyResolver;
    private readonly policyFacade?: PolicyEngine;

    constructor(
        private readonly sidecarRunner: SidecarRunner,
        private readonly traceRecorder?: SessionTraceRecorder,
        private readonly config?: ResolvedConfig,
        policyResolver?: PolicyResolver,
        policyFacade?: PolicyEngine,
    ) {
        this.policyResolver = policyResolver;
        this.policyFacade = policyFacade;
    }

    async runSidecar(
        session: SessionState,
        options: Partial<SidecarOptions>,
    ): Promise<{ containerId: string; name: string }> {
        if (!session.workspaceDir) {
            throw new Error(`Session ${session.id} does not have a workspace directory.`);
        }
        if (!session.containerId) {
            throw new Error(`Session ${session.id} does not have a primary container.`);
        }
        const admission = readCloudAdmissionRuntimeOwnership(session);
        if (admission.runId && admission.admissionEpoch) {
            // The current minimum-progress bundle accounts for the primary plus
            // one worker, not an unbounded extra Docker sidecar. Keep this
            // dormant path fail-closed until sidecars acquire their own lease.
            throw new Error('cloud_sidecar_capacity_not_reserved');
        }

        const sidecarName = options.name ?? this.buildSidecarName(session.id);
        const resolvedProfile = await (async () => {
            if (this.policyFacade) {
                return this.policyFacade.resolveSandboxCapabilities(
                    options.capabilityProfile || session.sandboxProfile,
                );
            }
            if (!this.policyResolver) {
                throw new Error('policy.resolver_uninitialized');
            }
            return resolveCapabilityProfile(
                options.capabilityProfile || session.sandboxProfile,
                this.config,
                this.policyResolver,
            );
        })();
        const containerId = await this.sidecarRunner.run(
            {
                name: sidecarName,
                shareNetworkWith: session.containerId,
                workspaceMount: session.workspaceDir,
                command: options.command,
                env: options.env,
                readonlyRootfs: options.readonlyRootfs,
                image: options.image,
                toolpack: options.toolpack,
                capabilityProfile: options.capabilityProfile,
                labels: {
                    ...buildAdmissionRuntimeLabels(session, 'sidecar'),
                    'nullai.container-scope': session.coordination?.role === 'worker' ? 'session' : 'run',
                    'nullai.created-at': Date.now().toString(),
                },
            },
            resolvedProfile,
        );

        const existing = this.sidecars.get(session.id) ?? new Set<string>();
        existing.add(containerId);
        this.sidecars.set(session.id, existing);

        this.recordSidecarCreation(session, containerId, sidecarName, resolvedProfile);

        return { containerId, name: sidecarName };
    }

    async stopSidecars(sessionId: string, containerId?: string): Promise<void> {
        const containers = this.sidecars.get(sessionId);
        if (!containers || containers.size === 0) {
            return;
        }

        const targets = containerId ? [containerId] : Array.from(containers);

        for (const targetId of targets) {
            try {
                await this.sidecarRunner.destroy(targetId);
            } catch (error) {
                this.log.warn({ err: error, sessionId, sidecarId: targetId }, 'Failed to remove sidecar');
            } finally {
                containers.delete(targetId);
            }
        }

        if (containers.size === 0) {
            this.sidecars.delete(sessionId);
        }
    }

    private buildSidecarName(sessionId: string): string {
        return `ns-sidecar-${sessionId}-${Date.now()}`;
    }

    private recordSidecarCreation(
        session: SessionState,
        containerId: string,
        name: string,
        profile: ResolvedCapabilityProfile,
    ) {
        const recorder = this.traceRecorder;
        if (recorder) {
            recorder
                .write(session.id, session.turn ?? 0, {
                    event: 'sandbox.sidecar.created',
                    severity: 'info',
                    payload: {
                        containerId,
                        name,
                        profile: profile.name,
                        capAdd: profile.capAdd,
                        capDrop: profile.capDrop,
                        privileged: profile.privileged,
                        network: profile.network,
                    },
                    note: summarizeForNote(`sidecar ${name}`),
                })
                .catch((error) => {
                    this.log.warn({ err: error, sessionId: session.id }, 'Failed to record sidecar creation');
                });
        }
    }
}
