import { type DockerDriver, type DockerCreateOptions } from './DockerDriver';
import { SandboxStatsSampler } from './SandboxStatsSampler';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { RuntimeBundleOwnership, SandboxDestroyOptions } from './types';
import type { SandboxListEntry } from './types';
import { type PolicyEnforcer } from './PolicyEnforcer';
import { type ImageResolver } from './ImageResolver';
import { type SessionState, type SandboxPolicySummary } from '../../domain/types';
import { type SessionStore } from '../../application/core/SessionStore';
import { resolveCapabilityProfile } from './capabilityProfiles';
import type { SessionTraceRecorder } from '../../infrastructure/telemetry';
import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { summarizeForNote } from '@/shared/utils/text';
import { type PolicyResolver } from '../../domain/policy';
import { type PolicyEngine } from '../../application/services/PolicyEngine';
import { buildAdmissionRuntimeLabels } from './runtimeOwnership';

// summarizeForNote imported from @/shared/utils/text

interface SandboxContainerInfo {
    id: string;
    lastUsed: number;
    scopeKey: string;
    name: string;
    runId?: string;
    policy?: SandboxPolicySummary;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const WORKSPACE_MOUNT_TARGET = '/workspace';

// Platform-owned runtime infrastructure directories that the runtime (not the agent)
// must write from INSIDE the worker container, even though the worker's root mount is
// read-only. These hold no findings/evidence/report content (they are runtime-owned and
// transient — see isTransientArtifactSubtreePath), so granting them read-write does not
// weaken evidence-integrity isolation; it only lets the runtime function:
//   - `.http_sessions`: curl cookie jar (HttpSessionManager / httpRequestExecutor); without
//     write access an authenticated request flow cannot persist cookies between calls.
//   - `.artifacts/shell-jobs`: managed shell-job scaffolding (ManagedShellJobService writes
//     command.sh/runner.sh/status.json/stdout.log per jobId); without write access EVERY
//     worker shell_run fails, because the default shell path runs as a managed job.
// (Host-side writes such as `.artifacts/tool-results` are unaffected by the container mount
// and do not need an entry here. Proxy/mitm capture is skipped for workers entirely.)
const WORKER_RUNTIME_WRITABLE_SUBDIRS = [
    '.http_sessions',
    '.artifacts/shell-jobs',
    '.artifacts/python-session',
] as const;

// The agent's browser runs in the sandbox and keeps its profile and shared memory in /dev/shm, the one
// writable tmpfs on the read-only root. Docker's default of 64 MB is too small for Chromium.
const SANDBOX_SHM_SIZE_MB = 512;

type ContainerScope = {
    key: string;
    name: string;
    sessionId?: string;
    sharedRunId?: string;
};

export class ContainerLifecycleManager {
    private readonly containers = new Map<string, SandboxContainerInfo>();
    private readonly appliedPolicies = new Map<string, SandboxPolicySummary>();
    private cleanupInterval?: NodeJS.Timeout;

    constructor(
        private readonly docker: DockerDriver,
        private readonly policy: PolicyEnforcer,
        private readonly imageResolver: ImageResolver,
        private readonly ttlMs: number,
        private readonly sessionStore?: SessionStore,
        private readonly traceRecorder?: SessionTraceRecorder,
        private readonly config?: ResolvedConfig,
        private readonly log = logger.child({ scope: 'ContainerLifecycleManager' }),
        private readonly policyResolver?: PolicyResolver,
        private readonly policyFacade?: PolicyEngine,
    ) {
        this.startCleanupLoop();
    }

    private unsealedNetworkNoted = false;

    /** Said once, from the network a sandbox really gets, whichever setting chose it. */
    private noteUnsealedNetwork(network: unknown, profile: string): void {
        if (network !== 'bridge' || this.unsealedNetworkNoted) {
            return;
        }
        this.unsealedNetworkNoted = true;
        this.log.warn(
            { sandboxNetwork: network, profile },
            "Sandboxes run on Docker's default bridge: developer mode, without the seal. The agent's commands " +
                'and its browser can reach this computer and your network.',
        );
    }

    private sidecarCleaner?: (sessionId: string, containerId?: string) => Promise<void>;

    setSidecarCleaner(cleaner: (sessionId: string, containerId?: string) => Promise<void>): void {
        this.sidecarCleaner = cleaner;
    }

    private statsSampler?: SandboxStatsSampler;

    /**
     * D22 - which session a container currently belongs to.
     *
     * The sampler captured the session that first attached the container and kept writing to
     * it. In production run r1 the shared sandbox outlived recon by 45 minutes, so recon's
     * terminated session received 112 `sandbox.stats` events spanning validation and
     * reporting — the last at 19:18 for a phase that closed at 18:33. Per-session runtime,
     * CPU and memory sample counts, trace duration and activity recency were all misleading
     * as a result.
     *
     * Container telemetry belongs to whichever session is using the container now.
     */
    private readonly currentSessionByContainer = new Map<string, string>();

    /**
     * Lazily build the docker-stats sampler. Disabled when there is no trace
     * recorder or when `performance.dockerStatsEnabled` is explicitly false.
     * Samples come from the Docker daemon's own accounting so they work where a
     * cAdvisor sidecar cannot see short-lived container cgroups (Docker Desktop / WSL2).
     */
    private getStatsSampler(): SandboxStatsSampler | undefined {
        if (this.config?.performance?.dockerStatsEnabled === false) return undefined;
        const recorder = this.traceRecorder;
        if (!recorder) return undefined;
        if (!this.statsSampler) {
            this.statsSampler = new SandboxStatsSampler({
                statsFn: (id) => this.docker.stats(id),
                intervalMs: this.config?.performance?.dockerStatsIntervalMs ?? 5_000,
                emit: async (aggregate) => {
                    // Resolve at emit time, not at sample time.
                    const sessionId = this.currentSessionByContainer.get(aggregate.containerId)
                        ?? aggregate.sessionId;
                    await recorder.write(sessionId, 0, {
                        event: 'sandbox.stats',
                        severity: 'info',
                        payload: {
                            ...aggregate,
                            // Keep the attaching session visible, so a shared container is
                            // legible rather than looking like it moved.
                            sessionId,
                            attachedBySessionId: aggregate.sessionId,
                            containerShared: sessionId !== aggregate.sessionId,
                        },
                        note: summarizeForNote(`container=${aggregate.containerId} samples=${aggregate.samples}`),
                    });
                },
                onError: (err, containerId) => this.log.warn({ err, containerId }, 'Docker stats sampling failed'),
            });
        }
        return this.statsSampler;
    }

    async createContainer(session: SessionState): Promise<string> {
        if (!session.workspaceDir) {
            throw new Error(`Session ${session.id} does not have a workspace directory.`);
        }

        const scope = this.resolveContainerScope(session);
        const existing = this.containers.get(scope.key);
        if (existing) {
            if (await this.isContainerRunning(existing.id)) {
                await this.bindSessionToContainer(session, scope, existing.id, existing.policy);
                await this.ensureSharedContainerSessionState(session, existing);
                this.markSessionActive(session.id);
                return existing.id;
            }

            await this.removeContainer(existing.id);
            await this.stopSidecarsForContainer(session.id, existing.id);
            this.containers.delete(scope.key);
        }

        if (session.containerId) {
            const adoptable = await this.isAdoptableContainer(session.containerId, scope);
            if (adoptable) {
                const containerId = adoptable.id;
                this.containers.set(scope.key, {
                    id: containerId,
                    lastUsed: Date.now(),
                    scopeKey: scope.key,
                    name: scope.name,
                    ...(scope.sharedRunId ? { runId: scope.sharedRunId } : {}),
                });
                await this.bindSessionToContainer(session, scope, containerId);
                this.markSessionActive(session.id);
                return containerId;
            }

            await this.removeContainer(session.containerId);
            await this.stopSidecarsForContainer(session.id, session.containerId);
            this.appliedPolicies.delete(session.id);
            session.containerId = undefined;
        }

        const namedContainer = await this.isAdoptableContainer(scope.name, scope);
        if (namedContainer) {
            const containerId = namedContainer.id;
            this.containers.set(scope.key, {
                id: containerId,
                lastUsed: Date.now(),
                scopeKey: scope.key,
                name: scope.name,
                ...(scope.sharedRunId ? { runId: scope.sharedRunId } : {}),
            });
            await this.bindSessionToContainer(session, scope, containerId);
            this.markSessionActive(session.id);
            return containerId;
        }

        await this.removeContainer(scope.name);
        this.appliedPolicies.delete(session.id);

        const requestedProfile = session.sandboxProfile;
        const resolvedProfile = await (async () => {
            if (this.policyFacade) {
                return this.policyFacade.resolveSandboxCapabilities(session.sandboxProfile);
            }
            if (!this.policyResolver) {
                throw new Error('policy.resolver_uninitialized');
            }
            return resolveCapabilityProfile(session.sandboxProfile, this.config, this.policyResolver);
        })();
        session.sandboxProfile = resolvedProfile.name || session.sandboxProfile;
        this.noteUnsealedNetwork(resolvedProfile.network, resolvedProfile.name);

        if (this.traceRecorder) {
            if (requestedProfile && resolvedProfile.name && requestedProfile !== resolvedProfile.name) {
                await this.traceRecorder
                    .write(session.id, session.turn ?? 0, {
                        event: 'sandbox.profile_fallback',
                        severity: 'warn',
                        payload: {
                            requestedProfile,
                            resolvedProfile: resolvedProfile.name,
                            reason: 'requested_profile_resolved_to_different_policy',
                        },
                        note: summarizeForNote(`${requestedProfile} -> ${resolvedProfile.name}`),
                    })
                    .catch((err) => {
                        this.log.warn({ err, sessionId: session.id }, 'Failed to record sandbox profile fallback');
                    });
            }
            await this.traceRecorder
                .write(session.id, session.turn ?? 0, {
                    event: 'sandbox.policy.resolved',
                    severity: 'info',
                    payload: {
                        requestedProfile,
                        profile: resolvedProfile.name,
                        network: resolvedProfile.network,
                        privileged: resolvedProfile.privileged,
                        capDrop: resolvedProfile.capDrop,
                        capAdd: resolvedProfile.capAdd,
                    },
                    note: summarizeForNote(`policy=${resolvedProfile.name}`),
                })
                .catch((err) => {
                    this.log.warn({ err, sessionId: session.id }, 'Failed to record sandbox policy resolution');
                });
        }

        const mounts = await this.buildWorkspaceMounts(session);

        const resolvedImage = this.imageResolver.resolve({
            image: session.sandboxImage,
        });
        const imageInfo = await this.docker.inspectImage(resolvedImage);
        if (!imageInfo) {
            throw new Error(
                `Sandbox image '${resolvedImage}' is not available locally. Please build or pull it before running.`,
            );
        }

        let createOptions: DockerCreateOptions = {
            image: resolvedImage,
            name: scope.name,
            network: resolvedProfile.network,
            readonlyRootfs: resolvedProfile.readonlyRootfs,
            cpuQuota: this.config?.sandbox.cpuQuota,
            memoryMb: this.config?.sandbox.memoryMb,
            pidsLimit: this.config?.sandbox.pidsLimit,
            shmSizeMb: SANDBOX_SHM_SIZE_MB,
            mounts,
            // User: privileged always runs as root, otherwise use config.
            // TODO(P2): Support per-profile user configuration instead of global default.
            user: resolvedProfile.privileged ? 'root' : (this.config?.sandbox.user ?? 'root'),
            securityOpts: [],
            capDrop: resolvedProfile.capDrop,
            capAdd: resolvedProfile.capAdd,
            privileged: resolvedProfile.privileged,
            // Labels for container discovery (used by orphan cleanup on restart)
            labels: {
                ...buildAdmissionRuntimeLabels(session, 'sandbox'),
                'nullai.container-scope': scope.sharedRunId ? 'run' : 'session',
                'nullai.created-at': Date.now().toString(),
            },
        };

        createOptions = this.policy.applySecurityDefaults(createOptions, resolvedProfile);

        const policySummary: SandboxPolicySummary = {
            profile: resolvedProfile.name,
            privileged: Boolean(createOptions.privileged),
            capDrop: createOptions.capDrop ?? [],
            capAdd: createOptions.capAdd ?? [],
            readonlyRootfs: Boolean(createOptions.readonlyRootfs),
            network:
                typeof createOptions.network === 'string'
                    ? createOptions.network
                    : (`container:${createOptions.network.shareWith}` as const),
            seccomp: createOptions.seccompProfilePath ?? null,
        };

        const containerId = await this.docker.create(createOptions);

        // Update the passed session object
        this.containers.set(scope.key, {
            id: containerId,
            lastUsed: Date.now(),
            scopeKey: scope.key,
            name: scope.name,
            ...(scope.sharedRunId ? { runId: scope.sharedRunId } : {}),
            policy: policySummary,
        });
        await this.bindSessionToContainer(session, scope, containerId, policySummary);
        this.markSessionActive(session.id);

        this.writePolicyApplied(session.id, session.turn ?? 0, policySummary);
        this.recordCreation(session, containerId, createOptions.image, resolvedProfile.name, scope);
        await this.startHttpProxyCapture(session, containerId);
        try {
            this.getStatsSampler()?.start({
                containerId,
                sessionId: session.id,
                runId: scope.sharedRunId ?? null,
            });
        } catch (error) {
            this.log.warn({ err: error, sessionId: session.id }, 'Failed to start docker stats sampling');
        }

        return containerId;
    }

    // The capture proxy listens inside the sandbox. Everything that uses it runs there too, the agent's
    // browser included, so its one address is the sandbox's own loopback.
    private async startHttpProxyCapture(session: SessionState, containerId: string): Promise<void> {
        // Workers mount the shared run workspace read-only (except their writeScope and
        // runtime-infra submounts), so the proxy capture's mkdir/write under /workspace
        // would fail; and a worker's own-container mitmproxy would write into the parent's
        // shared capture file. The parent run session owns HTTP capture for the run.
        if (this.isWorkerSession(session)) {
            return;
        }
        const command = [
            'mkdir -p /workspace/.artifacts/proxy /workspace/.mitmproxy',
            'if ! command -v mitmdump >/dev/null 2>&1 || [ ! -f /opt/nullai/mitm_capture.py ]; then',
            '  echo NULLAI_HTTP_PROXY=unavailable',
            '  exit 0',
            'fi',
            'if ps aux | grep -F "mitm_capture.py" | grep -v grep >/dev/null 2>&1; then',
            '  echo NULLAI_HTTP_PROXY=already_running',
            '  exit 0',
            'fi',
            'NULLAI_HTTP_CAPTURE_PATH=/workspace/.http-proxy.ndjson nohup mitmdump --listen-host 0.0.0.0 --listen-port 8080 --set confdir=/workspace/.mitmproxy -s /opt/nullai/mitm_capture.py > /workspace/.artifacts/proxy/mitmproxy.log 2>&1 &',
            'echo $! > /workspace/.artifacts/proxy/mitmproxy.pid',
            'sleep 0.2',
            'if ps aux | grep -F "mitm_capture.py" | grep -v grep >/dev/null 2>&1; then',
            '  echo NULLAI_HTTP_PROXY=started',
            'else',
            '  echo NULLAI_HTTP_PROXY=failed',
            '  exit 1',
            'fi',
        ].join('\n');

        try {
            const result = await this.docker.exec(containerId, {
                cmd: command,
                user: 'root',
                timeoutMs: 5_000,
            });
            const output = `${result.stdout}\n${result.stderr}`;
            if (result.exitCode !== 0 || !/NULLAI_HTTP_PROXY=(started|already_running)/.test(output)) {
                this.log.info(
                    {
                        sessionId: session.id,
                        exitCode: result.exitCode,
                        output: summarizeForNote(output),
                    },
                    'HTTP proxy capture unavailable for sandbox container',
                );
                return;
            }
            session.flags = {
                ...(session.flags ?? {}),
                httpProxy: {
                    enabled: true,
                    url: 'http://127.0.0.1:8080',
                    capturePath: '.http-proxy.ndjson',
                },
            };
            if (this.sessionStore) {
                const currentSession = this.sessionStore.get(session.id);
                if (currentSession) {
                    currentSession.flags = {
                        ...(currentSession.flags ?? {}),
                        httpProxy: session.flags.httpProxy,
                    };
                    this.sessionStore.set(session.id, currentSession);
                }
            }
        } catch (error) {
            this.log.warn({ err: error, sessionId: session.id }, 'Failed to start HTTP proxy capture');
        }
    }

    async destroyContainer(session: SessionState, options: SandboxDestroyOptions = {}): Promise<void> {
        const scope = this.resolveContainerScope(session);
        const containerInfo = this.containers.get(scope.key);
        const containerId = session.containerId || containerInfo?.id;
        if (!containerId) {
            return;
        }

        if (this.sidecarCleaner) {
            await this.sidecarCleaner(session.id, containerId).catch((err) => {
                this.log.warn({ err, sessionId: session.id }, 'Failed to stop sidecars during destroy');
            });
        }
        if (scope.sharedRunId && this.hasOtherActiveRunSession(scope.sharedRunId, session.id, containerId)) {
            await this.clearSessionContainer(session, 'sandbox.stop.detach', options);
            this.appliedPolicies.delete(session.id);
            return;
        }

        if (scope.sharedRunId) {
            await this.stopSidecarsForRun(scope.sharedRunId, containerId, session.id);
        }

        // Flush docker-stats samples (final reading) while the container is still alive.
        await this.getStatsSampler()
            ?.stop(containerId)
            .catch((error) => {
                this.log.warn({ err: error, containerId }, 'Failed to flush docker stats samples');
            });

        await this.removeContainer(containerId);
        this.containers.delete(scope.key);
        await this.clearSessionsForContainer(containerId, 'sandbox.stop.cleanup', [session], options);

        this.appliedPolicies.delete(session.id);

        this.recordDestruction(session, containerId);
    }

    async listActiveContainers(): Promise<SandboxListEntry[]> {
        return this.docker.listByLabel('nullai.sandbox', 'true');
    }

    /**
     * Destroy and prove absence of every sandbox/sidecar owned by one admitted
     * Run epoch. Labels remain authoritative after a backend restart.
     */
    async destroyOwnedBundleAndVerify(ownership: RuntimeBundleOwnership): Promise<void> {
        const listOwnedIds = async (): Promise<string[]> => {
            const entries = await this.docker.listByLabel('nullai.run-id', ownership.runId);
            const owned: string[] = [];
            for (const entry of entries) {
                const inspected = await this.docker.inspect(entry.ID);
                const config = isRecord(inspected?.['Config']) ? inspected['Config'] : undefined;
                const labels = isRecord(config?.['Labels']) ? config['Labels'] : undefined;
                if (
                    labels?.['nullai.sandbox'] === 'true' &&
                    labels['nullai.run-id'] === ownership.runId &&
                    labels['nullai.admission-epoch'] === String(ownership.admissionEpoch)
                ) {
                    owned.push(entry.ID);
                }
            }
            return owned;
        };

        const before = await listOwnedIds();
        for (const containerId of before) {
            await this.getStatsSampler()
                ?.stop(containerId)
                .catch((error) => {
                    this.log.warn({ err: error, containerId }, 'Failed to flush docker stats during bundle teardown');
                });
            await this.removeContainer(containerId);
            for (const [scopeKey, info] of this.containers.entries()) {
                if (info.id === containerId) this.containers.delete(scopeKey);
            }
        }

        const remaining = await listOwnedIds();
        if (remaining.length > 0) {
            throw new Error(
                `sandbox_bundle_teardown_unverified: run=${ownership.runId};epoch=${ownership.admissionEpoch};remaining=${remaining.join(',')}`,
            );
        }
    }

    async restartContainer(containerId: string): Promise<void> {
        await this.docker.restart(containerId);
    }

    async pauseContainer(containerId: string): Promise<void> {
        await this.docker.pause(containerId);
    }

    async unpauseContainer(containerId: string): Promise<void> {
        await this.docker.unpause(containerId);
    }

    async stopContainer(containerId: string): Promise<void> {
        await this.removeContainer(containerId);

        const sessions = this.listSessionsForContainer(containerId);
        const sidecarSessionIds = new Set(sessions.map((session) => session.id));
        const fallbackSessions: SessionState[] = [];

        for (const [scopeKey, info] of this.containers.entries()) {
            if (info.id === containerId) {
                this.containers.delete(scopeKey);
                const sessionId = this.sessionIdFromScopeKey(info.scopeKey ?? scopeKey);
                if (sessionId) {
                    sidecarSessionIds.add(sessionId);
                    const session = this.sessionStore?.get(sessionId);
                    if (session) {
                        fallbackSessions.push(session);
                    }
                }
            }
        }

        await this.clearSessionsForContainer(containerId, 'sandbox.ensure.active', [...sessions, ...fallbackSessions]);

        if (this.sidecarCleaner) {
            for (const sessionId of sidecarSessionIds) {
                await this.sidecarCleaner(sessionId, containerId).catch((err) => {
                    this.log.warn({ err, sessionId }, 'Failed to stop sidecars during stopContainer');
                });
            }
        }
    }

    getContainerId(sessionId: string): string | undefined {
        const session = this.sessionStore?.get(sessionId);
        return session?.containerId;
    }

    getAppliedPolicy(sessionId: string): SandboxPolicySummary | undefined {
        return this.appliedPolicies.get(sessionId);
    }

    markSessionActive(sessionId: string): void {
        const session = this.sessionStore?.get(sessionId);
        const scopeKey = session ? this.resolveContainerScope(session).key : `session:${sessionId}`;
        const info = this.containers.get(scopeKey) ?? this.containers.get(sessionId);
        if (info) {
            info.lastUsed = Date.now();
            this.containers.set(info.scopeKey ?? scopeKey, info);
        }
    }

    private async removeContainer(containerId: string): Promise<void> {
        // D22 - a destroyed container owns no session's telemetry.
        this.currentSessionByContainer.delete(containerId);
        try {
            await this.docker.destroy(containerId);
        } catch (error) {
            this.log.warn({ err: error, containerId }, 'Failed to remove container');
            throw error;
        }
    }

    private async isContainerRunning(containerId: string): Promise<boolean> {
        try {
            const containerInfo = await this.docker.inspect(containerId);
            const state = isRecord(containerInfo) ? containerInfo['State'] : undefined;
            return isRecord(state) && state['Running'] === true;
        } catch {
            return false;
        }
    }

    private async stopSidecarsForContainer(sessionId: string, containerId: string): Promise<void> {
        if (!this.sidecarCleaner) {
            return;
        }

        await this.sidecarCleaner(sessionId, containerId).catch((err) => {
            this.log.warn({ err, sessionId, containerId }, 'Failed to stop sidecars for discarded container');
        });
    }

    private resolveContainerScope(session: SessionState): ContainerScope {
        const runId = this.resolveRunId(session);
        if (runId && !this.isWorkerSession(session)) {
            return {
                key: `run:${runId}`,
                name: `ns-run-${runId}`,
                sharedRunId: runId,
            };
        }

        return {
            key: `session:${session.id}`,
            name: `ns-agent-${session.id}`,
            sessionId: session.id,
        };
    }

    private resolveRunId(session: SessionState): string | undefined {
        const securityops = isRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
        const runId = securityops?.runId;
        return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : undefined;
    }

    private isWorkerSession(session: SessionState): boolean {
        return session.coordination?.role === 'worker';
    }

    private normalizeWorkerWriteScope(workspaceDir: string, rawScope: string): { source: string; target: string } {
        let candidate = rawScope.trim().replace(/\\/g, '/');
        if (!candidate) {
            throw new Error('Worker writeScope cannot be empty.');
        }
        if (candidate.startsWith(`${WORKSPACE_MOUNT_TARGET}/`)) {
            candidate = candidate.slice(`${WORKSPACE_MOUNT_TARGET}/`.length);
        } else if (candidate === WORKSPACE_MOUNT_TARGET) {
            throw new Error('Worker writeScope cannot grant the entire workspace.');
        } else if (candidate.startsWith('workspace/')) {
            candidate = candidate.slice('workspace/'.length);
        }
        if (candidate.startsWith('./')) {
            candidate = candidate.slice(2);
        }
        while (candidate.startsWith('/')) {
            candidate = candidate.slice(1);
        }
        if (
            !candidate ||
            candidate === '.' ||
            candidate.includes('\0') ||
            candidate.startsWith('../') ||
            candidate.includes('/../')
        ) {
            throw new Error(`Worker writeScope resolves outside workspace: ${rawScope}`);
        }

        const workspaceRoot = path.resolve(workspaceDir);
        const source = path.resolve(workspaceRoot, candidate);
        const relative = path.relative(workspaceRoot, source);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Worker writeScope resolves outside workspace: ${rawScope}`);
        }

        return {
            source,
            target: `${WORKSPACE_MOUNT_TARGET}/${relative.replace(/\\/g, '/')}`,
        };
    }

    private async buildWorkspaceMounts(session: SessionState): Promise<DockerCreateOptions['mounts']> {
        if (!this.isWorkerSession(session)) {
            return [
                {
                    source: session.workspaceDir,
                    target: WORKSPACE_MOUNT_TARGET,
                    readOnly: false,
                },
            ];
        }

        const mounts: NonNullable<DockerCreateOptions['mounts']> = [
            {
                source: session.workspaceDir,
                target: WORKSPACE_MOUNT_TARGET,
                readOnly: true,
            },
        ];
        const seenTargets = new Set<string>();
        const addReadWriteSubmount = async (rawScope: string): Promise<void> => {
            const mount = this.normalizeWorkerWriteScope(session.workspaceDir, rawScope);
            if (seenTargets.has(mount.target)) {
                return;
            }
            await fs.mkdir(mount.source, { recursive: true });
            mounts.push({ ...mount, readOnly: false });
            seenTargets.add(mount.target);
        };
        for (const scope of session.coordination?.writeScope ?? []) {
            if (typeof scope !== 'string') {
                continue;
            }
            await addReadWriteSubmount(scope);
        }
        // Runtime-owned infra dirs are always read-write for workers, independent of the
        // agent-declared writeScope, so the runtime can persist cookie jars etc. without
        // re-opening write access to evidence/report/scan artifacts.
        for (const subdir of WORKER_RUNTIME_WRITABLE_SUBDIRS) {
            await addReadWriteSubmount(subdir);
        }
        return mounts;
    }

    private startCleanupLoop(): void {
        const interval = Math.max(Math.floor(this.ttlMs / 2), 60_000);
        this.cleanupInterval = setInterval(() => {
            this.reapStaleContainers().catch((error) => {
                this.log.warn({ err: error }, 'Sandbox cleanup loop encountered an error');
            });
        }, interval);
        this.cleanupInterval.unref?.();
    }

    private async reapStaleContainers(): Promise<void> {
        const cutoff = Date.now() - this.ttlMs;

        for (const [scopeKey, info] of this.containers.entries()) {
            if (info.lastUsed < cutoff) {
                const sessionId = this.sessionIdFromScopeKey(info.scopeKey ?? scopeKey);
                const legacySession = sessionId ? this.sessionStore?.get(sessionId) : undefined;
                const sessions = [...this.listSessionsForContainer(info.id), ...(legacySession ? [legacySession] : [])];
                await this.removeContainer(info.id);
                this.containers.delete(scopeKey);
                if (this.sidecarCleaner) {
                    for (const session of sessions) {
                        await this.sidecarCleaner(session.id, info.id).catch((err) => {
                            this.log.warn(
                                { err, sessionId: session.id },
                                'Failed to stop sidecars for stale container',
                            );
                        });
                    }
                }
                await this.clearSessionsForContainer(info.id, 'sandbox.remove.active', sessions);
                // Note: Sidecar cleanup should be triggered here too, but we'll handle that via callback or event if needed.
                // For now, SandboxManager will coordinate or we can pass a callback.
            }
        }
    }

    private writePolicyApplied(sessionId: string, turn: number, summary: SandboxPolicySummary): void {
        const recorder = this.traceRecorder;
        if (!recorder) {
            return;
        }

        recorder
            .write(sessionId, turn, {
                event: 'sandbox.policy.applied',
                severity: 'info',
                payload: summary,
                note: summarizeForNote(`${summary.profile} caps=${summary.capAdd.join(',') || 'none'}`),
            })
            .catch((error) => {
                this.log.warn({ err: error, sessionId }, 'Failed to record sandbox policy');
            });
    }

    private async isAdoptableContainer(
        containerIdOrName: string,
        scope: ContainerScope,
    ): Promise<{ id: string } | null> {
        let inspected: unknown;
        try {
            inspected = await this.docker.inspect(containerIdOrName);
        } catch {
            return null;
        }
        if (!isRecord(inspected)) {
            return null;
        }
        const state = isRecord(inspected['State']) ? inspected['State'] : undefined;
        if (state?.['Running'] !== true) {
            return null;
        }
        const config = isRecord(inspected['Config']) ? inspected['Config'] : undefined;
        const labels = isRecord(config?.['Labels']) ? (config['Labels'] as Record<string, unknown>) : {};
        if (scope.sharedRunId) {
            if (labels['nullai.container-scope'] !== 'run' || labels['nullai.run-id'] !== scope.sharedRunId) {
                return null;
            }
        } else {
            if (labels['nullai.container-scope'] === 'run') {
                return null;
            }
            if (
                labels['nullai.container-scope'] === 'session' &&
                scope.sessionId &&
                labels['nullai.session-id'] !== scope.sessionId
            ) {
                return null;
            }
        }
        const inspectedId =
            typeof inspected['Id'] === 'string' && inspected['Id'].trim().length > 0
                ? inspected['Id']
                : containerIdOrName;
        return { id: inspectedId };
    }

    private async bindSessionToContainer(
        session: SessionState,
        scope: ContainerScope,
        containerId: string,
        policy?: SandboxPolicySummary,
    ): Promise<void> {
        session.containerId = containerId;
        // D22 - this session now owns the container's telemetry until another one takes it.
        this.currentSessionByContainer.set(containerId, session.id);
        if (policy) {
            this.appliedPolicies.set(session.id, policy);
        }

        if (!this.sessionStore) {
            return;
        }

        const currentSession = this.sessionStore.get(session.id);
        if (currentSession) {
            currentSession.containerId = containerId;
            this.sessionStore.set(session.id, currentSession);
        } else {
            this.sessionStore.set(session.id, session);
        }

        const info = this.containers.get(scope.key);
        if (info) {
            info.lastUsed = Date.now();
            if (policy) {
                info.policy = policy;
            }
            this.containers.set(scope.key, info);
        }

        this.recordAttachment(session, containerId, scope, policy);
    }

    private async ensureSharedContainerSessionState(session: SessionState, info: SandboxContainerInfo): Promise<void> {
        if (!info.runId || !info.policy) {
            return;
        }
        await this.startHttpProxyCapture(session, info.id);
    }

    private async clearSessionContainer(
        session: SessionState,
        reason: string,
        options: SandboxDestroyOptions = {},
    ): Promise<void> {
        session.containerId = undefined;
        if (options.sessionRemovalId === session.id) {
            return;
        }
        if (!this.sessionStore) {
            return;
        }
        const current = this.sessionStore.get(session.id);
        if (current) {
            current.containerId = undefined;
            await this.sessionStore.setAsync(session.id, current, reason);
        }
    }

    private listAllSessions(): SessionState[] {
        const store = this.sessionStore as unknown as { listSessions?: () => SessionState[] } | undefined;
        return store?.listSessions?.() ?? [];
    }

    private listSessionsForContainer(containerId: string): SessionState[] {
        return this.listAllSessions().filter((session) => session.containerId === containerId);
    }

    private sessionIdFromScopeKey(scopeKey: string): string | undefined {
        if (scopeKey.startsWith('session:')) {
            return scopeKey.slice('session:'.length);
        }
        if (scopeKey.startsWith('run:')) {
            return undefined;
        }
        // Compatibility with pre-collapse in-memory maps that were keyed by raw session id.
        return scopeKey || undefined;
    }

    private hasOtherActiveRunSession(runId: string, currentSessionId: string, containerId: string): boolean {
        return this.listAllSessions().some(
            (session) =>
                session.id !== currentSessionId &&
                this.resolveRunId(session) === runId &&
                session.containerId === containerId &&
                session.completed !== true,
        );
    }

    private async clearSessionsForContainer(
        containerId: string,
        reason: string,
        fallbackSessions: SessionState[] = [],
        options: SandboxDestroyOptions = {},
    ): Promise<void> {
        const sessionsById = new Map<string, SessionState>();
        for (const session of [...this.listSessionsForContainer(containerId), ...fallbackSessions]) {
            if (session.containerId === containerId) {
                sessionsById.set(session.id, session);
            }
        }
        const sessions = [...sessionsById.values()];
        if (sessions.length === 0) {
            return;
        }
        for (const session of sessions) {
            this.appliedPolicies.delete(session.id);
            await this.clearSessionContainer(session, reason, options);
        }
    }

    private async stopSidecarsForRun(runId: string, containerId: string, exceptSessionId?: string): Promise<void> {
        if (!this.sidecarCleaner) {
            return;
        }
        for (const session of this.listAllSessions()) {
            if (session.id === exceptSessionId) {
                continue;
            }
            if (this.resolveRunId(session) !== runId || session.containerId !== containerId) {
                continue;
            }
            await this.sidecarCleaner(session.id, containerId).catch((err) => {
                this.log.warn({ err, sessionId: session.id }, 'Failed to stop run sidecars during destroy');
            });
        }
    }

    private recordCreation(
        session: SessionState,
        containerId: string,
        image: string,
        profile: string,
        scope: ContainerScope,
    ) {
        const recorder = this.traceRecorder;
        const limits = this.buildDockerLimitSummary();
        if (recorder) {
            recorder
                .write(session.id, session.turn ?? 0, {
                    event: 'sandbox.created',
                    severity: 'info',
                    payload: {
                        containerId,
                        image,
                        profile,
                        containerName: scope.name,
                        containerScope: scope.sharedRunId ? 'run' : 'session',
                        limits,
                        ...(scope.sharedRunId ? { runId: scope.sharedRunId } : {}),
                    },
                    note: summarizeForNote(`container=${containerId}`),
                })
                .catch((error) => {
                    this.log.warn({ err: error, sessionId: session.id }, 'Failed to record sandbox creation');
                });
        }
    }

    private recordAttachment(
        session: SessionState,
        containerId: string,
        scope: ContainerScope,
        policy?: SandboxPolicySummary,
    ) {
        const recorder = this.traceRecorder;
        const limits = this.buildDockerLimitSummary();
        if (recorder) {
            recorder
                .write(session.id, session.turn ?? 0, {
                    event: 'sandbox.attached',
                    severity: 'info',
                    payload: {
                        containerId,
                        containerName: scope.name,
                        containerScope: scope.sharedRunId ? 'run' : 'session',
                        ...(policy
                            ? {
                                  profile: policy.profile,
                                  network: policy.network,
                                  limits,
                              }
                            : {}),
                        ...(scope.sharedRunId ? { runId: scope.sharedRunId } : {}),
                    },
                    note: summarizeForNote(`container=${containerId}`),
                })
                .catch((error) => {
                    this.log.warn({ err: error, sessionId: session.id }, 'Failed to record sandbox attachment');
                });
        }
    }

    private buildDockerLimitSummary(): {
        cpuQuota: number | null;
        memoryMb: number | null;
        memoryBytes: number | null;
        pidsLimit: number | null;
        enforced: boolean;
        source: 'docker' | 'config';
    } {
        const cpuQuota = this.config?.sandbox.cpuQuota ?? null;
        const memoryMb = this.config?.sandbox.memoryMb ?? null;
        const pidsLimit = this.config?.sandbox.pidsLimit ?? null;
        const enforced = cpuQuota !== null || memoryMb !== null || pidsLimit !== null;
        return {
            cpuQuota,
            memoryMb,
            memoryBytes: memoryMb ? memoryMb * 1024 * 1024 : null,
            pidsLimit,
            enforced,
            source: enforced ? 'docker' : 'config',
        };
    }

    private recordDestruction(session: SessionState, containerId: string) {
        const recorder = this.traceRecorder;
        if (recorder) {
            recorder
                .write(session.id, session.turn ?? 0, {
                    event: 'sandbox.destroyed',
                    severity: 'info',
                    payload: {
                        containerId,
                    },
                    note: summarizeForNote(`container=${containerId}`),
                })
                .catch((error) => {
                    this.log.warn({ err: error, sessionId: session.id }, 'Failed to record sandbox destruction');
                });
        }
    }
}
