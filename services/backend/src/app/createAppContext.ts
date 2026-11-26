import { ConfigService } from '@/config/configService';
import type { ResolvedConfig } from '@/config/configTypes';
import AgentSessionHistoryService from '@/domains/agent-brain/infrastructure/history/agentSessionHistoryService';
import { getNetworkSettings } from '@/domains/platform/settings/networkSettings';
import { getRuntimeSettings } from '@/domains/platform/settings/runtimeSettings';
import { getSandboxSettings } from '@/domains/platform/settings/sandboxSettings';
import { getTraceSettings } from '@/domains/platform/settings/traceSettings';

import type { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { SandboxAdapter } from '@/domains/agent-brain/adapters/sandbox';
import { ModelService } from '@/domains/platform/models/ModelService';
import type { createAgentServices } from '@/app/services/agent/createAgentServices';
import type { OrchestratorAdapter } from '@/domains/agent-brain/application/orchestration/OrchestratorAdapter';
import type { StreamBroker } from '@/domains/agent-brain/application/core/StreamBroker';
import type { ToolsRegistry } from '@/domains/agent-brain/adapters/tools/ToolsRegistry';
import type { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';
import type { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';
import type { TraceRetentionService } from '@/domains/agent-brain/infrastructure/telemetry';
import type { SandboxProfileRegistry } from '@/domains/agent-brain/adapters/sandbox';
import type { SessionEventJournalPort, UsageStorePort, WorkspaceManager } from '@/domains/agent-brain/ports';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { DIContainer } from './container';
import { LifecycleManager } from './lifecycle';
import { TOKENS } from './tokens';
import { registerOrchestration } from './factories/orchestration';
import { registerStorage } from './factories/storage';
import { registerTelemetry } from './factories/telemetry';
import type { S3Bundle } from './factories/storage';
import { ensureDatabaseSchema } from './startupChecks';
import { logger } from '@/shared/logger';
import { browserSessionManager } from '@/domains/agent-brain/adapters/tools/runtime/browserSessionManager';
import type { PolicyEngine } from '@/domains/agent-brain/application/services/PolicyEngine';
import type { TokenGuard } from '@/domains/agent-brain/application/services/TokenGuard';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence/SessionRepository';
import { ToolExecutionAdapter } from '@/domains/agent-brain/adapters/ToolExecutionAdapter';
import { SessionJournalRecoveryService } from '@/domains/agent-brain/application/services/SessionJournalRecoveryService';

import { SessionLifecycleService } from '@/domains/agent-brain/application/services/SessionLifecycleService';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { SESSION_RETENTION_INTERVAL_MS } from '@/config/timeouts';
import { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { AdvisoryRepository } from '@/domains/security-ops/advisories/AdvisoryRepository';
import { AdvisorySyncService } from '@/domains/security-ops/advisories/AdvisorySyncService';
import { NvdClient } from '@/domains/security-ops/advisories/NvdClient';
import { isThreatWatchCycleDue } from '@/domains/security-ops/advisories/threatWatchHealth';
import { ExposureMatchService } from '@/domains/security-ops/exposure/ExposureMatchService';
import { getThreatWatchSettings } from '@/domains/platform/settings/threatWatchSettings';
import { ExposureLeadInjector } from '@/domains/security-ops/exposure/ExposureLeadInjector';
import { ExposureNotifier } from '@/domains/security-ops/exposure/ExposureNotifier';
import { ThreatWatchCycleService } from '@/domains/security-ops/exposure/ThreatWatchCycleService';
import { ComponentInventoryService } from '@/domains/security-ops/components/ComponentInventoryService';
import { RefreshFingerprintJob } from '@/domains/security-ops/components/RefreshFingerprintJob';
import { ExposureVerificationService } from '@/domains/security-ops/exposure/ExposureVerificationService';
import { createAutomationRunExecutor } from '@/domains/security-ops/automations/buildAutomationRunExecutor';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { RunService } from '@/domains/security-ops/runs/RunService';
import { StartRunService } from '@/domains/security-ops/runs/StartRunService';
import { RunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
import { WorkspaceProjectionService } from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { FailedEventService } from '@/domains/security-ops/resilience/FailedEventService';
import { createAgentRepositories } from '@/app/services/agent/agentRepositories';
import { createSubscriptionPort, createModelConfigPort } from '@/app/adapters/portFactories';
import { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { db } from '@/db/client';
import { withPostgresAdvisoryLock } from '@/db/postgresAdvisoryLock';
import { runs } from '@/db/schema';
import { inArray } from 'drizzle-orm';
import { mapStreamEventToTimelineEntries } from '@/domains/agent-brain/application/orchestration/utils/timelineEntries';
import {
  FindingDispositionVerificationWorker,
  type FindingDispositionWorkerHealth,
} from '@/domains/security-ops/findings/FindingDispositionVerificationWorker';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';
import { RunControlSignalListener } from '@/domains/security-ops/runs/RunControlSignal';
import { loadCloudRunSchedulingConfig } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';
import { CapacityLeaseService } from '@/domains/security-ops/runs/scheduling/CapacityLeaseService';
import {
  SystemRecoveryWorker,
  createSystemRecoveryRepositories,
} from '@/domains/security-ops/runs/SystemRecoveryWorker';
import {
  createOrganizationRuntimeHostCapabilities,
  createResearchLabRuntimeHostCapabilities,
  resolveRuntimeHostCapabilities,
  type RuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';

export type AppContext = {
  runtimeHostCapabilities: RuntimeHostCapabilities;
  streamBroker: StreamBroker;
  sessionStore: SessionStore;
  sandbox: SandboxAdapter;
  traceRecorder: SessionTraceRecorder;
  agentServices: ReturnType<typeof createAgentServices>;
  usageStore: UsageStorePort;
  workspaceManager: WorkspaceManager;
  sessionTTL: number;
  toolsRegistry: ToolsRegistry;
  checkpointManager: CheckpointManager;
  orchestrator: OrchestratorAdapter;
  sandboxProfileRegistry: SandboxProfileRegistry;
  redis?: { ping: () => Promise<unknown> } | undefined;
  networkSettings: Awaited<ReturnType<typeof getNetworkSettings>>;
  sandboxSettings: Awaited<ReturnType<typeof getSandboxSettings>>;
  runtimeSettings: Awaited<ReturnType<typeof getRuntimeSettings>>;
  traceSettings: Awaited<ReturnType<typeof getTraceSettings>>;
  config: ResolvedConfig;
  isDev: boolean;
  appRole?: string;
  enableWorkers?: boolean;
  findingDispositionWorkerHealth?: FindingDispositionWorkerHealth;
  /** Undefined on nodes without workers; callers must handle its absence. */
  startRunService?: StartRunService;
  dispose?: () => Promise<void> | void;
  s3ArtifactsClient?: S3StorageService;
  s3TracesClient?: S3StorageService;
  s3WorkspacesClient?: S3StorageService;
  s3ArtifactsBucket?: string;
  s3TracesBucket?: string;
  s3WorkspacesBucket?: string;
  policyResolver: PolicyResolver;
  policyFacade: PolicyEngine;
  tokenGuard: TokenGuard;
};

export type AppContextOptions = {
  /**
   * Sidecar hosts use the same runtime components without starting or
   * reconciling organization-product run lifecycle state.
   */
  productHost?: 'platform' | 'research_lab';
  /**
   * Hosted product-path evaluations need durable agent_sessions because real
   * product run rows reference them. This does not enable platform lifecycle
   * reconciliation or organization hooks in the sidecar.
   */
  persistSessions?: boolean;
  /** Explicit adapter declaration; Research Lab passes its port-compatible owner set. */
  runtimeHostCapabilities?: RuntimeHostCapabilities;
  /** Research Lab injects its run-scoped durable provider-attempt owner. */
  providerAttemptStore?: UsageStorePort;
};

type WorkspaceManagerMaintenance = {
  startJanitor?: (ttlMs: number, intervalMs: number) => void;
  stopJanitor?: () => void;
  startQuotaEnforcer?: (intervalMs: number) => void;
  stopQuotaEnforcer?: () => void;
};

const ensureS3Buckets = (s3Bundle: S3Bundle): void => {
  if (s3Bundle.s3Client) {
    void s3Bundle.s3Client.ensureBucket().catch((err) =>
      logger.warn({ err }, '[S3] ensure artifacts bucket failed'),
    );
  }
  if (s3Bundle.s3TracesClient) {
    void s3Bundle.s3TracesClient.ensureBucket().catch((err) =>
      logger.warn({ err }, '[S3] ensure traces bucket failed'),
    );
  }
  if (s3Bundle.s3WorkspacesClient) {
    void s3Bundle.s3WorkspacesClient.ensureBucket().catch((err) =>
      logger.warn({ err }, '[S3] ensure workspaces bucket failed'),
    );
  }
};

const attachSessionHooks = async (
  sessionStore: SessionStore,
  sandboxAdapter: SandboxAdapter,
  agentSessionHistoryService?: AgentSessionHistoryService,
) => {
  sessionStore.setOnSessionRemove(async (session, reason) => {
    await browserSessionManager.cleanup(session.id);
    await sandboxAdapter.destroy(session, { sessionRemovalId: session.id });
    await agentSessionHistoryService?.markSessionEnded(session, reason);
  });
};

const startTimers = (
  lifecycle: LifecycleManager,
  sessionStore: SessionStore,
  sandboxAdapter: SandboxAdapter,
  workspaceManager: WorkspaceManager,
  sessionTTL: number,
  traceRetentionService?: TraceRetentionService,
  traceRetentionDays?: number,
  agentSessionHistoryService?: AgentSessionHistoryService,
  snapshotIntervalMs?: number,
) => {
  const snapshotInterval = Number(snapshotIntervalMs ?? 15_000);
  const persistActiveAgentSessions = async (): Promise<void> => {
    try {
      const sessions = sessionStore.listSessions();
      if (sessions.length === 0) {
        return;
      }
      await agentSessionHistoryService?.upsertSnapshots(sessions);
    } catch (error) {
      logger.warn({ err: error }, 'Failed to persist active agent sessions');
    }
  };

  agentSessionHistoryService
    ?.expireStaleSessions(sessionTTL)
    .catch((error: unknown) => logger.warn({ err: error }, 'Failed to expire stale agent sessions'));

  const sessionSnapshotTimer = setInterval(() => {
    void persistActiveAgentSessions();
  }, snapshotInterval);
  lifecycle.trackInterval(sessionSnapshotTimer);
  void persistActiveAgentSessions();

  const janitorIntervalMs = Math.max(Math.min(sessionTTL, 30 * 60 * 1000), 5 * 60 * 1000);
  const janitorTTL = sessionTTL * 2;
  const workspaceMaintenance = workspaceManager as WorkspaceManagerMaintenance;
  const startJanitor = workspaceMaintenance.startJanitor;
  if (typeof startJanitor === 'function') {
    startJanitor.call(workspaceManager, janitorTTL, janitorIntervalMs);
  }
  const quotaIntervalMs = Math.max(5 * 60 * 1000, Math.min(sessionTTL, 30 * 60 * 1000));
  const startQuotaEnforcer = workspaceMaintenance.startQuotaEnforcer;
  if (typeof startQuotaEnforcer === 'function') {
    startQuotaEnforcer.call(workspaceManager, quotaIntervalMs);
  }

  const retentionTimer =
    traceRetentionService && (traceRetentionDays ?? 0) > 0
      ? setInterval(() => {
        void traceRetentionService.cleanup().catch((err) => {
          logger.warn({ err }, '[Retention] cleanup failed');
        });
      }, 12 * 60 * 60 * 1000)
      : undefined;
  if (retentionTimer) {
    lifecycle.trackInterval(retentionTimer);
  }

  // Runtime recovery is DB-first. Expired execution claims and due journal
  // continuations are owned by SystemRecoveryWorker on worker nodes.

  lifecycle.track(async () => {
    const stopJanitor = workspaceMaintenance.stopJanitor;
    if (typeof stopJanitor === 'function') {
      stopJanitor.call(workspaceManager);
    }
    const stopQuotaEnforcer = workspaceMaintenance.stopQuotaEnforcer;
    if (typeof stopQuotaEnforcer === 'function') {
      stopQuotaEnforcer.call(workspaceManager);
    }
    sessionStore.shutdown();
    const sessions = sessionStore.listSessions();
    await Promise.allSettled(sessions.map((session) => sandboxAdapter.destroy(session)));
  });
};

export const createAppContext = async (
  options: AppContextOptions = {},
): Promise<AppContext> => {
  const productHost = options.productHost ?? 'platform';
  const runtimeHostCapabilities = resolveRuntimeHostCapabilities(
    options.runtimeHostCapabilities
      ?? (productHost === 'research_lab'
        ? createResearchLabRuntimeHostCapabilities()
        : createOrganizationRuntimeHostCapabilities()),
  );
  const expectedHostKind = productHost === 'research_lab' ? 'research_lab' : 'organization';
  if (runtimeHostCapabilities.hostKind !== expectedHostKind) {
    throw new Error(
      `Runtime host capability mismatch: productHost=${productHost} capabilities=${runtimeHostCapabilities.hostKind}`,
    );
  }
  logger.info({
    event: 'runtime_host.capabilities_resolved',
    runtimeHostCapabilities,
  }, '[AppContext] Runtime host capabilities resolved');

  const configService = await ConfigService.create();
  const effectiveConfig = configService.get();
  const envConfig = configService.getEnv();
  const isDev = envConfig.NODE_ENV !== 'production';
  const [networkSettings, sandboxSettings, runtimeSettings, traceSettings] =
    await Promise.all([
      getNetworkSettings(),
      getSandboxSettings(),
      getRuntimeSettings(),
      getTraceSettings(),
    ]);

  const lifecycle = new LifecycleManager();
  const container = new DIContainer();
  const sessionTTL = (effectiveConfig.runtime.sessionTTLMinutes ?? 120) * 60 * 1000;

  await ensureDatabaseSchema();

  // A fresh install has no model yet, and still opens. The person connects one model: in Settings →
  // Models (ChatGPT plan or an API key), or `npm run db:seed` connects an `*_API_KEY` from .env or the
  // configured default in config/seeds/models.seed.json. Until then a run has no model to use.
  const defaultModel = await new ModelService().getDefaultMetadataOrNull();
  if (!defaultModel?.modelName) {
    logger.warn(
      '[Config] No model is connected yet. Connect one in Settings → Model, or put a provider key (ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, QWEN_API_KEY or MOONSHOT_API_KEY) in .env and start again.',
    );
  }

  registerStorage(container, lifecycle, effectiveConfig, envConfig, sessionTTL, {
    runtimeHostCapabilities,
    providerAttemptStore: options.providerAttemptStore,
  });
  registerTelemetry(container, effectiveConfig);
  registerOrchestration(container, effectiveConfig, sessionTTL, {
    runtimeHostCapabilities,
    persistSessions: options.persistSessions,
  });

  const appRole = envConfig.APP_ROLE ?? 'api';
  const enableWorkers =
    typeof envConfig.ENABLE_WORKERS === 'boolean' ? envConfig.ENABLE_WORKERS : appRole === 'worker';
  const cloudSchedulingConfig = loadCloudRunSchedulingConfig(process.env, effectiveConfig.sandbox);
  const agentSessionHistoryService = new AgentSessionHistoryService(effectiveConfig);

  const [
    streamBroker,
    sessionStore,
    sandboxPort,
    traceRecorder,
    agentServices,
    usageStore,
    workspaceManager,
    toolsRegistry,
    checkpointManager,
    orchestrator,
    sandboxProfileRegistry,

    s3Bundle,
    traceRetentionService,
    policyResolver,
    policyFacade,
    tokenGuard,
    sessionEventJournal,

  ] = await Promise.all([
    container.resolve<StreamBroker>(TOKENS.streamBroker),
    container.resolve<SessionStore>(TOKENS.sessionStore),
    container.resolve<SandboxAdapter>(TOKENS.sandboxPort),
    container.resolve<SessionTraceRecorder>(TOKENS.traceRecorder),
    container.resolve<ReturnType<typeof createAgentServices>>(TOKENS.agentServices),
    container.resolve<UsageStorePort>(TOKENS.usageStore),
    container.resolve<WorkspaceManager>(TOKENS.workspaceManager),
    container.resolve<ToolsRegistry>(TOKENS.toolsRegistry),
    container.resolve<CheckpointManager>(TOKENS.checkpointManager),
    container.resolve<OrchestratorAdapter>(TOKENS.orchestrator),
    container.resolve<SandboxProfileRegistry>(TOKENS.sandboxProfileRegistry),

    container.resolve<S3Bundle>(TOKENS.s3Bundle),
    container.resolve<TraceRetentionService | undefined>(TOKENS.traceRetentionService),
    container.resolve<PolicyResolver>(TOKENS.policyResolver),
    container.resolve<PolicyEngine>(TOKENS.policyEngine),
    container.resolve<TokenGuard>(TOKENS.tokenGuard),
    container.resolve<SessionEventJournalPort>(TOKENS.sessionEventJournal),
  ]);

  logger.info(
    {
      perSessionLimit: tokenGuard.getConfig().perSessionLimit,
      perUserDailyLimit: tokenGuard.getConfig().perUserDailyLimit,
      warningThresholdPct: tokenGuard.getConfig().warningThresholdPct,
    },
    '[AppContext] TokenGuard initialized',
  );

  ensureS3Buckets(s3Bundle);
  if (enableWorkers) {
    await sandboxPort.preflight().catch((err) => {
      logger.error({ err }, '[AppContext] Sandbox preflight failed');
      throw err;
    });

    // Clean up orphan containers from previous backend crashes/restarts
    // Uses label-based discovery to find stale containers without active sessions
    try {
      const { reapOrphanContainersOnStartup } = await import('@/domains/agent-brain/adapters/sandbox/OrphanContainerReaper');
      const { DockerDriver } = await import('@/domains/agent-brain/adapters/sandbox/DockerDriver');
      const docker = new DockerDriver((msg) => logger.debug({ msg }, '[OrphanReaper] docker'));
      const sessionRepository = new SessionRepository();
      
      const result = await reapOrphanContainersOnStartup(docker, sessionRepository, workspaceManager);
      if (result.reaped > 0) {
        logger.info(
          {
            found: result.found,
            reaped: result.reaped,
            ids: result.reapedContainerIds,
            workspacesFound: result.workspacesFound,
            workspacesReaped: result.workspacesReaped,
          },
          '[AppContext] Cleaned up orphan sandbox resources from previous run',
        );
      } else if (result.workspacesReaped > 0) {
        logger.info(
          {
            workspacesFound: result.workspacesFound,
            workspacesReaped: result.workspacesReaped,
            workspaces: result.reapedWorkspaces,
          },
          '[AppContext] Cleaned up orphan sandbox workspaces from previous run',
        );
      } else if (result.found > 0) {
        logger.debug(
          { found: result.found, workspacesFound: result.workspacesFound },
          '[AppContext] All sandbox containers and workspaces have active owners',
        );
      }
    } catch (err) {
      logger.warn({ err }, '[AppContext] Orphan container cleanup failed (non-fatal, continuing startup)');
    }
  } else if (!enableWorkers) {
    logger.info('[AppContext] Preflight skipped because workers are disabled (ENABLE_WORKERS=false)');
  }
  sandboxPort.bindSessionStore(sessionStore);
  const organizationLifecycleEnabled = options.productHost !== 'research_lab';
  await attachSessionHooks(
    sessionStore,
    sandboxPort,
    organizationLifecycleEnabled ? agentSessionHistoryService : undefined,
  );
  sessionStore.setToolSchemaProvider(() => toolsRegistry.getToolSchemas());

  // Keep run rows synchronized from the canonical session.status event stream.
  // This covers explicit Stop/Start plus user input, approval continuation,
  // and reconciler-triggered recovery.
  const runStatusSessionRepository = new SessionRepository();
  let runStatusSyncService: RunService | undefined;
  if (organizationLifecycleEnabled) {
    const runStatusOrgService = new OrganizationService(db);
    const runStatusScopeService = new ScopeService(db);
    const runStatusSkillContextService = new RunSkillContextService();
    runStatusSyncService = new RunService(
      db,
      runStatusOrgService,
      runStatusScopeService,
      {
        sessionStatusPort: runStatusSessionRepository,
        skillContextService: runStatusSkillContextService,
      },
    );
    const detachRunStatusObserver = streamBroker.observe((sessionId, event) => {
      if (event.type !== 'session.status') {
        return;
      }
      const payload = event.data as { status?: unknown; blocked_reason?: unknown } | undefined;
      if (typeof payload?.status !== 'string') {
        return;
      }
      const runStatus =
        payload.status === 'paused' && typeof payload.blocked_reason === 'string'
          ? payload.blocked_reason
          : payload.status;
      void runStatusSyncService?.onSessionStatusChange(sessionId, runStatus).catch((error) => {
        logger.warn({ err: error, sessionId, status: runStatus }, '[AppContext] Failed to synchronize run status from session.status');
      });
    });
    lifecycle.track(() => detachRunStatusObserver());
  }

  const detachLiveToolStreamObserver = streamBroker.observe((sessionId, event) => {
    if (event.type === 'tool_started') {
      const args =
        event.data && typeof event.data.args === 'object' && event.data.args !== null
          ? (event.data.args as Record<string, unknown>)
          : undefined;
      const command = typeof args?.command === 'string' ? args.command : undefined;
      sessionStore.recordLiveToolStart(sessionId, event.data.name, command);
      return;
    }
    if (event.type === 'tool_output') {
      sessionStore.appendLiveToolOutput(sessionId, event.data.name, event.data.chunk);
      return;
    }
    if (event.type === 'tool_result') {
      sessionStore.recordLiveToolResult(sessionId, event.data.name, event.data.result);
    }
  });
  lifecycle.track(() => detachLiveToolStreamObserver());

  const detachTimelineMapperObserver = streamBroker.observe((sessionId, event) => {
    if (event.type === 'timeline_event') {
      return;
    }
    const session = sessionStore.get(sessionId);
    const entries = mapStreamEventToTimelineEntries({
      sessionId,
      event,
      session,
    });
    for (const entry of entries) {
      streamBroker.emit(sessionId, {
        type: 'timeline_event',
        data: entry,
      });
    }
  });
  lifecycle.track(() => detachTimelineMapperObserver());

  const detachTimelinePersistenceObserver = streamBroker.observe((sessionId, event) => {
    if (event.type !== 'timeline_event') {
      return;
    }
    sessionStore.recordTimelineEntry(sessionId, event.data);
  });
  lifecycle.track(() => detachTimelinePersistenceObserver());

  const isWorkerRole = appRole === 'worker';
  let findingDispositionWorkerHealth: FindingDispositionWorkerHealth | undefined;
  /**
   * Exposed so HTTP routes that start runs — Threat Watch verification, for one —
   * can reuse the assembled service instead of rebuilding it. Undefined on nodes
   * that do not run workers, which callers must treat as "not available here"
   * rather than assuming a run can be started.
   */
  let startRunServiceRef: StartRunService | undefined;
  if (enableWorkers) {
    startTimers(
      lifecycle,
      sessionStore,
      sandboxPort,
      workspaceManager,
      sessionTTL,
      traceRetentionService,
      traceSettings.traceRetentionDays,
      agentSessionHistoryService,
      envConfig.AGENT_SESSION_SNAPSHOT_INTERVAL_MS,
    );

    // Stale session detection is now handled by orchestrator timeouts
    // and periodic dead session cleanup above

    // No Redis health checks needed - Redis is no longer used
    logger.info('[AppContext] Redis removed - using PostgreSQL-only storage');


    // If sandbox fails, tool execution will fail fast and user can retry

    // Over-engineered Active→Archived→Deleted lifecycle removed per GPT 5.2 research
    // Simple retention: session TTL + ON DELETE CASCADE handles cleanup

    if (isWorkerRole) {
      const securityOpsOrgService = new OrganizationService(db);
      const securityOpsScopeService = new ScopeService(db);
      const securityOpsRunnerService = new RunnerService(db);
      const securityOpsRunSkillContextService = new RunSkillContextService();
      const securityOpsWorkspaceProjectionService = new WorkspaceProjectionService(db);
      const securityOpsRepositories = createAgentRepositories();
      const securityOpsSessionRepository = securityOpsRepositories.sessionRepository;
      const securityOpsRunService = new RunService(
        db,
        securityOpsOrgService,
        securityOpsScopeService,
        {
          sessionStatusPort: securityOpsSessionRepository,
          skillContextService: securityOpsRunSkillContextService,
        },
      );
      const securityOpsAccessControl = new AccessControlService();
      const securityOpsSubscriptionPort = createSubscriptionPort(securityOpsAccessControl);
      const securityOpsModelConfigPort = createModelConfigPort();
      const securityOpsSessionService = new SessionService(
        agentServices.sessionStore,
        agentServices.sandboxProfileRegistry,
        agentServices.ports,
        agentServices.agentEngine,
        securityOpsSubscriptionPort,
        agentServices.policyResolver,
        securityOpsModelConfigPort,
        agentServices.traceRecorder,
        securityOpsSessionRepository,
        agentServices.policyFacade,
      );
      const failedEventService = new FailedEventService(db);
      const capacityLeaseService = new CapacityLeaseService(db, cloudSchedulingConfig);
      const startRunService = new StartRunService({
        runService: securityOpsRunService,
        scopeService: securityOpsScopeService,
        runnerService: securityOpsRunnerService,
        sessionService: securityOpsSessionService,
        agentServices,
        sessionRepository: securityOpsSessionRepository,
        scopeAccessMaterialService: new ScopeAccessMaterialService(db),
        workspaceProjectionService: securityOpsWorkspaceProjectionService,
        // Turns unverified Threat Watch matches into work the validation phase
        // must close, so an exposure is answered by an assessment the customer
        // already bought rather than decaying into an unread notification.
        exposureLeadInjector: new ExposureLeadInjector(db),
        cloudScheduling: {
          config: cloudSchedulingConfig,
          leases: capacityLeaseService,
        },
      });
      startRunServiceRef = startRunService;

      const recoveryRepositories = createSystemRecoveryRepositories(db);
      const systemRecoveryWorker = new SystemRecoveryWorker({
        db,
        sessions: recoveryRepositories.sessions,
        replans: recoveryRepositories.replans,
        runService: securityOpsRunService,
        startRunService,
        leases: capacityLeaseService,
        config: cloudSchedulingConfig,
        agentServices,
        journalRecovery: new SessionJournalRecoveryService(
          sessionEventJournal,
          new ToolExecutionAdapter(db),
          usageStore,
        ),
      });
      const processSystemRecovery = () => {
        void systemRecoveryWorker
          .tick()
          .then((summary) => {
            if (summary.sessionsRecovered > 0 || summary.replansDispatched > 0) {
              return startRunService.startReadyPhaseRuns();
            }
          })
          .catch((error) => logger.error({ err: error }, '[SystemRecovery] Sweep failed'));
      };
      processSystemRecovery();
      const systemRecoveryInterval = setInterval(processSystemRecovery, 2_000);
      lifecycle.trackInterval(systemRecoveryInterval);
      logger.info('[AppContext] System recovery worker started');
      const findingDispositionWorker = new FindingDispositionVerificationWorker({
        db,
        startRunService,
        runService: securityOpsRunService,
        agentServices,
        sessionRepository: securityOpsSessionRepository,
        accessControl: securityOpsAccessControl,
      });
      findingDispositionWorkerHealth = findingDispositionWorker.health;
      let findingDispositionTickInFlight = false;
      const processFindingDispositionVerifications = () => {
        if (findingDispositionTickInFlight) return;
        findingDispositionTickInFlight = true;
        void findingDispositionWorker
          .sweep()
          .catch((error) => logger.error({ err: error }, '[FindingDisposition] Verification worker sweep failed'))
          .finally(() => {
            findingDispositionTickInFlight = false;
          });
      };
      processFindingDispositionVerifications();
      const findingDispositionInterval = setInterval(processFindingDispositionVerifications, 10_000);
      lifecycle.trackInterval(findingDispositionInterval);
      logger.info('[AppContext] Finding disposition verification worker started (worker-only, every 10 seconds)');

      const abortSignalledRun = async (runId: string) => {
        await abortLiveRunSessions({
          runId,
          services: agentServices,
          sessionRepository: securityOpsSessionRepository,
          caller: 'run_control_signal',
          publishSignal: false,
        });
      };
      const runControlListener = new RunControlSignalListener(
        abortSignalledRun,
        async () => {
          const localRunIds = Array.from(new Set(
            sessionStore
              .listSessions()
              .map((session) => {
                const securityops =
                  session.flags?.securityops
                  && typeof session.flags.securityops === 'object'
                  && !Array.isArray(session.flags.securityops)
                    ? session.flags.securityops as Record<string, unknown>
                    : null;
                return typeof securityops?.runId === 'string' ? securityops.runId.trim() : '';
              })
              .filter(Boolean),
          ));
          if (localRunIds.length === 0) return;
          const cancelledIds = new Set(
            (await db
              .select({ id: runs.id, status: runs.status })
              .from(runs)
              .where(inArray(runs.id, localRunIds)))
              .filter((row) => row.status === 'cancelled')
              .map((row) => row.id),
          );
          for (const runId of cancelledIds) {
            await abortSignalledRun(runId);
          }
        },
      );
      runControlListener.start();
      lifecycle.track(() => runControlListener.stop());
      void securityOpsRunService
        .reconcileAllActiveRuns()
        .then(() => startRunService.startReadyPhaseRuns())
        .catch((error) => logger.error({ err: error }, '[Runs] Startup ready-phase start failed'));
      const automationService = new AutomationService({
        db,
        runExecutor: createAutomationRunExecutor({
          startRunService,
          scopeService: securityOpsScopeService,
          runService: securityOpsRunService,
          accessControl: securityOpsAccessControl,
          allowExecution: true,
        }),
      });

      // Phase 6: evaluate due automations every 60 seconds.
      let automationTickInFlight = false;
      const automationEvaluationInterval = setInterval(() => {
        if (automationTickInFlight) {
          return;
        }
        automationTickInFlight = true;
        void automationService
          .evaluateDueAutomations()
          .then((result) => {
            if (result.errors.length > 0) {
              logger.error({ errors: result.errors }, '[Automations] Evaluation completed with errors');
            }
          })
          .catch((err) => logger.error({ err }, '[Automations] Evaluation tick failed'))
          .finally(() => {
            automationTickInFlight = false;
          });
      }, 60_000);
      lifecycle.trackInterval(automationEvaluationInterval);

      // Threat Watch: sync advisories, match them against customer inventory,
      // and age out stale matches.
      //
      // Controlled from database settings rather than the environment, so an
      // operator can pause a noisy feed or hold notifications back without a
      // redeploy, and the change is audited like any other configuration change.
      // The interval re-reads settings on every tick, which is what makes a
      // settings change take effect on the next cycle.
      //
      // The API key stays in the environment because it is a secret. Keyless
      // operation is supported at a lower, explicitly paced request budget.
      {
        const advisoryRepository = new AdvisoryRepository(db);
        const advisorySyncService = new AdvisorySyncService(
          db,
          new NvdClient({ apiKey: envConfig.THREAT_WATCH_NVD_API_KEY ?? null }),
          advisoryRepository,
        );
        const fingerprintRefresh = new RefreshFingerprintJob(
          db,
          new ComponentInventoryService(db),
        );
        const threatWatchCycle = new ThreatWatchCycleService(
          db,
          advisorySyncService,
          new ExposureMatchService(db),
          {},
          undefined,
          {
            advisoryRepository,
            verificationService: new ExposureVerificationService(db),
            notifier: new ExposureNotifier(db),
          },
        );

        // Ticks on a fixed short cadence and decides *inside* the tick whether
        // this is a due cycle. A settings change therefore takes effect without
        // a restart, which a `setInterval` sized from settings at boot could
        // never do.
        const TICK_MS = 60_000;
        let threatWatchTickInFlight = false;

        const threatWatchInterval = setInterval(() => {
          if (threatWatchTickInFlight) return;
          threatWatchTickInFlight = true;

          void (async () => {
            const initialSettings = await getThreatWatchSettings().catch((err) => {
              logger.warn({ err }, '[ThreatWatch] Could not read settings; skipping tick');
              return null;
            });

            if (!initialSettings?.syncEnabled) return;

            const initialState = await advisoryRepository.loadFeedState('nvd');
            const initialNow = new Date();
            const intervalMinutes = Math.max(initialSettings.syncIntervalMinutes ?? 120, 120);
            if (!isThreatWatchCycleDue({
              enabled: true,
              intervalMinutes,
              nvd: initialState,
              now: initialNow,
            })) return;

            // Own the entire cycle across replicas. NVD ingestion, exploitation
            // snapshots, matching, the volume breaker, and notification caps
            // must not each elect a different writer.
            const locked = await withPostgresAdvisoryLock(
              db.$client,
              'threat-watch:cycle',
              async () => {
                // Recheck after ownership. A peer may have completed between
                // the optimistic due check above and this non-blocking lock.
                const settings = await getThreatWatchSettings();
                if (!settings.syncEnabled) return null;

                const now = new Date();
                const nvd = await advisoryRepository.loadFeedState('nvd');
                const currentIntervalMinutes = Math.max(
                  settings.syncIntervalMinutes ?? 120,
                  120,
                );
                if (!isThreatWatchCycleDue({
                  enabled: true,
                  intervalMinutes: currentIntervalMinutes,
                  nvd,
                  now,
                })) return null;

                const refresh = await fingerprintRefresh.refreshStaleAssets({
                  olderThanDays: 7,
                  limit: 50,
                }).catch((error) => {
                  logger.warn(
                    { err: error },
                    '[ThreatWatch] Passive fingerprint refresh failed; advisory cycle continues',
                  );
                  return null;
                });
                const cycle = await threatWatchCycle.runCycle({
                  reconcile: true,
                  enrich: true,
                  sync: {
                    maxPagesPerRun: Math.max(1, settings.maxPagesPerRun ?? 10),
                    nextRunAt: new Date(
                      now.getTime() + currentIntervalMinutes * 60_000,
                    ),
                    // A completed historical window or a page-budget pause is
                    // unfinished work, not the next steady-state poll. One
                    // minute remains safely outside NVD's keyless 30-second
                    // request window and makes initial protection available in
                    // tens of minutes instead of several days.
                    continuationNextRunAt: new Date(now.getTime() + 60_000),
                    retryNextRunAt: new Date(now.getTime() + 15 * 60_000),
                  },
                });
                return { ...cycle, fingerprintRefresh: refresh };
              },
            );

            if (!locked.acquired) {
              logger.debug('[ThreatWatch] Another replica owns the current cycle');
            } else if (locked.value) {
              logger.info(locked.value, '[ThreatWatch] Cycle complete');
            }
          })()
            .catch((err) => logger.error({ err }, '[ThreatWatch] Cycle tick failed'))
            .finally(() => {
              threatWatchTickInFlight = false;
            });
        }, TICK_MS);
        lifecycle.trackInterval(threatWatchInterval);

        logger.info(
          { hasNvdApiKey: Boolean(envConfig.THREAT_WATCH_NVD_API_KEY) },
          '[ThreatWatch] Scheduler installed; sync is controlled from settings',
        );
      }

      // Phase 5: quarantine stale private runners that stop heartbeating.
      const runnerQuarantineInterval = setInterval(() => {
        void securityOpsRunnerService
          .quarantineStaleRunners()
          .then(async (quarantined) => {
            if (quarantined.length > 0) {
              logger.warn({ count: quarantined.length }, '[Runners] Quarantined stale private runners');
            }

            for (const runner of quarantined) {
              const runnerOfflinePayload = {
                runnerId: runner.id,
                runnerName: runner.name,
                status: 'quarantined',
                lastHeartbeatAt: runner.lastHeartbeatAt?.toISOString() ?? null,
              };
              try {
                await automationService.evaluateEvent(runner.organizationId, {
                  type: 'runner_offline',
                  payload: runnerOfflinePayload,
                });
              } catch (error) {
                logger.error(
                  { err: error, runnerId: runner.id, organizationId: runner.organizationId },
                  '[Runners] Failed to dispatch runner-offline automation event',
                );
                await failedEventService.recordFailure({
                  organizationId: runner.organizationId,
                  eventType: 'automation.evaluate_event',
                  payload: {
                    channel: 'automation',
                    source: 'workers.runner_quarantine',
                    eventType: 'runner_offline',
                    eventPayload: runnerOfflinePayload,
                  },
                  error,
                });
              }
            }
          })
          .catch((err) => logger.error({ err }, '[Runners] Failed stale-runner quarantine tick'));
      }, 60_000);
      lifecycle.trackInterval(runnerQuarantineInterval);

      // Phase 2.3: retry failed automation/notification events (DLQ) every 60 seconds.
      let failedEventsTickInFlight = false;
      const failedEventsRetryInterval = setInterval(() => {
        if (failedEventsTickInFlight) {
          return;
        }
        failedEventsTickInFlight = true;

        void failedEventService
          .retryDueFailures({
            automationService,
          })
          .then((summary) => {
            if (summary.failed > 0 || summary.exhausted > 0) {
              logger.error({ summary }, '[FailedEvents] Retry cycle completed with failures');
              return;
            }
            if (summary.attempted > 0) {
              logger.info({ summary }, '[FailedEvents] Retry cycle completed');
            }
          })
          .catch((error) => {
            logger.error({ err: error }, '[FailedEvents] Retry cycle failed');
          })
          .finally(() => {
            failedEventsTickInFlight = false;
          });
      }, 60_000);
      lifecycle.trackInterval(failedEventsRetryInterval);

      // Phase 2.3.5: reconcile stale active runs every 60 seconds.
      // RunService marks runs failed only after sustained inactivity (60 minutes by default)
      // and only when runtime checks indicate no active processing.
      let runReconcileTickInFlight = false;
      const runReconcileInterval = setInterval(() => {
        if (runReconcileTickInFlight) {
          return;
        }
        runReconcileTickInFlight = true;

        void securityOpsRunService
          .reconcileAllActiveRuns()
          .then(() => startRunService.startReadyPhaseRuns())
          .catch((error) => {
            logger.error({ err: error }, '[Runs] Active-run reconciliation tick failed');
          })
          .finally(() => {
            runReconcileTickInFlight = false;
          });
      }, 60_000);
      lifecycle.trackInterval(runReconcileInterval);

      // Retention is lifecycle cleanup. SystemRecoveryWorker owns continuation.
      const { sessionRetentionAdapter } = await import('@/domains/agent-brain/adapters/SessionRetentionAdapter');
      const sessionLifecycle = SessionLifecycleService.forWorkers({
        sessionLifecycleConfig: effectiveConfig.sessionLifecycle,
        retentionPort: sessionRetentionAdapter,
      });
      sessionLifecycle.startWorkers(SESSION_RETENTION_INTERVAL_MS);
      lifecycle.track(() => sessionLifecycle.stopWorkers());
      logger.info('[AppContext] Session retention worker started');

      // Periodic orphan container cleanup (industry standard: label-based discovery + reconciliation)
      // Runs every 5 minutes to catch containers orphaned between startup cleanups
      try {
        const { startPeriodicOrphanReaper } = await import('@/domains/agent-brain/adapters/sandbox/OrphanContainerReaper');
        const { DockerDriver } = await import('@/domains/agent-brain/adapters/sandbox/DockerDriver');
        const orphanDocker = new DockerDriver((msg) => logger.debug({ msg }, '[OrphanReaper] docker'));
        const orphanReaper = startPeriodicOrphanReaper(
          orphanDocker,
          securityOpsSessionRepository,
          5 * 60 * 1000,
          workspaceManager,
        );
        lifecycle.track(() => orphanReaper.stop());
        logger.info('[AppContext] Periodic orphan container cleanup started (worker-only, every 5 minutes)');
      } catch (err) {
        logger.warn({ err }, '[AppContext] Failed to start periodic orphan cleanup (non-fatal)');
      }
    }
  } else {
    logger.info(
      '[AppContext] Workers disabled; timers and janitors not started (enable via ENABLE_WORKERS=true)',
    );
  }
  const dispose = async (): Promise<void> => {
    try {
      // Shutdown is a hard work boundary. Abort the registered turn
      // controllers before closing stores/sandboxes so an in-flight provider
      // stream cannot keep generating tokens while HTTP connections drain.
      const liveSessions = sessionStore.listSessions();
      await Promise.allSettled(
        liveSessions
          // listSessions intentionally returns JSON-safe snapshots, so its
          // stateMachine has no methods. Inspect the live cache entry when
          // deciding whether shutdown must schedule immediate reconciliation.
          .filter((session) => {
            if (session.mode !== 'automated') return false;
            const liveStateMachine = sessionStore.get(session.id)?.stateMachine;
            return typeof liveStateMachine?.isProcessing === 'function'
              && liveStateMachine.isProcessing();
          })
          .map((session) => sessionStore.recordExecutionDeferredAsync(
            session.id,
            'application_shutdown',
            new Date(),
            `shutdown:${session.turn ?? 0}`,
          )),
      );
      await Promise.allSettled(
        liveSessions.map((session) =>
          sessionStore.abortCurrentTurnAsync(session.id, 'application_shutdown')),
      );
      await browserSessionManager.shutdown();
      await lifecycle.dispose();
    } catch (error) {
      logger.warn({ err: error }, '[AppContext] Error during dispose');
    }
  };

  return {
    runtimeHostCapabilities,
    streamBroker,
    sessionStore,
    sandbox: sandboxPort,
    traceRecorder,
    agentServices,
    usageStore,
    workspaceManager,
    sessionTTL,
    toolsRegistry,
    checkpointManager,
    orchestrator,
    sandboxProfileRegistry,
    networkSettings,
    sandboxSettings,
    runtimeSettings,
    traceSettings,
    config: effectiveConfig,
    isDev,
    appRole,
    enableWorkers,
    findingDispositionWorkerHealth,
    startRunService: startRunServiceRef,
    s3ArtifactsClient: s3Bundle.s3Client,
    s3TracesClient: s3Bundle.s3TracesClient,
    s3WorkspacesClient: s3Bundle.s3WorkspacesClient,
    s3ArtifactsBucket: s3Bundle.s3ArtifactsBucket,
    s3TracesBucket: s3Bundle.s3TracesBucket,
    s3WorkspacesBucket: s3Bundle.s3WorkspacesBucket,
    dispose,
    policyResolver,
    policyFacade,
    tokenGuard,
  };
};

export default createAppContext;

