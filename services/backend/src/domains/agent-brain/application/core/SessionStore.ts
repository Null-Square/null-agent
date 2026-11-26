import { v4 as uuidv4 } from 'uuid';
import type { WorkspaceManager } from '../../ports';
import { SessionPersistenceService, type SessionPersistenceDeps } from '../../infrastructure/persistence/SessionPersistenceService';
import type { HydrationOptions } from '../../ports/sessionRepository';
import { SessionPersistenceAdapter } from './SessionPersistenceAdapter';
import { SessionStateCache } from './SessionStateCache';
import {
  type CheckpointMetadata,
  type LiveToolStreamState,
  type Message,
  type PlanItem,
  type SessionCoordination,
  type SessionFlags,
  type SessionState,
  type SessionTaskMeta,
  type ToolAccessPolicy,
  type WorkerResultArtifact,
  type WorkerTaskRecord,
} from '../../domain/types';
import type { SessionExecutionReadModel, TimelineEntry } from '@null-ai/contracts';
import type { AgentType, PromptProfile } from '../../domain/prompts/agentPrompts';
import type { SessionCleanupService, CleanupSessionPort } from '../services/SessionCleanupService';
import type { CheckpointStoreService, CheckpointSessionPort } from '../services/CheckpointStoreService';
import { SessionLifecycleService } from '../services/SessionLifecycleService';
import { SessionJournalService } from '../services/SessionJournalService';
import { TurnManagementService, type TurnManagementPort } from '../services/TurnManagementService';
import type {
  SessionEventJournalPort,
  SessionExecutionCoordinationFacts,
  SessionRepositoryPort,
} from '../../ports';
import type { SessionJournalFold, SessionToolOutcome } from '../../domain/session-journal';
import {
  projectLegacySessionExecutionReadModel,
  projectSessionExecutionReadModel,
} from '../read-models';
import { logger as appLogger } from '@/shared/logger';
import { summarizeForNote, deriveTitleFromPrompt } from '@/shared/utils/text';
import type { SessionTraceRecorder, SessionTraceSeed } from '../../infrastructure/telemetry';
import { cloneSession, cloneFlags, parseFlagPath } from '../../domain/helpers';
import { createSessionStateMachine } from '../../domain/state';
import { MemoryManager } from '../../domain/helpers/MemoryManager';
import { sanitizeLiveToolResult } from './liveToolStreamSanitizer';

const LIVE_TOOL_STREAM_MAX_CHARS = 50_000;
const LIVE_TOOL_PERSIST_DEBOUNCE_MS = 750;
const TIMELINE_MAX_ENTRIES = 150;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const readRunIdFromFlags = (flags: SessionFlags | undefined): string | undefined => {
  const securityops = isPlainRecord(flags?.securityops) ? flags.securityops : undefined;
  return readString(securityops?.runId);
};

const readSessionCompletedFromFlags = (flags: SessionFlags | undefined): boolean => {
  const session = isPlainRecord(flags?.session) ? flags.session : undefined;
  const completed = (session as Record<string, unknown> | undefined)?.completed;
  return completed === true || completed === 'true';
};

const isSessionActiveForRunWorkspace = (session: SessionState): boolean => {
  if (session.completed === true || readSessionCompletedFromFlags(session.flags)) {
    return false;
  }
  if (session.blockedReason === 'aborted_by_user') {
    return false;
  }
  return true;
};

const deriveTraceAgentRole = (
  session: Pick<SessionState, 'agentType' | 'coordination' | 'flags'>,
): string => {
  const securityops = isPlainRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
  const activePhaseKey = readString(securityops?.activePhaseKey);
  if (session.coordination?.role === 'worker') {
    return session.coordination.workerType ? `worker:${session.coordination.workerType}` : 'worker';
  }
  if (session.agentType === 'planner') {
    return 'planner';
  }
  if (session.agentType === 'executor') {
    if (activePhaseKey) {
      return `phase:${activePhaseKey}`;
    }
    return 'executor';
  }
  return session.agentType ?? 'chat';
};

export interface SessionCreateOptions {
  userId?: string;
  profileKey?: string;
  promptProfile?: PromptProfile;
  extraContext?: string;
  flags?: SessionFlags;
  scopeId?: string;
  agentType?: AgentType;
  task?: SessionTaskMeta;
  toolPolicy?: ToolAccessPolicy;
  planSeed?: PlanItem[];
  planVersionHash?: string;
  softContextBlocks?: string[];
  sandboxProfile?: string;
  sandboxImage?: string;
  mode?: 'interactive' | 'automated';
  executionMode?: SessionState['executionMode'];
  coordination?: SessionCoordination;
  workerTasks?: WorkerTaskRecord[];
  workerResult?: WorkerResultArtifact;
  /** Model's context window size from DB (wired, not hardcoded) */
  modelContextWindow?: number;
  /** Model's max output tokens from DB */
  modelMaxOutputTokens?: number;
  /** Model name selected for this session (from DB) */
  modelName?: string;
  /** Optional per-session sampling temperature. */
  modelTemperature?: number;
}

// summarizeForNote and deriveTitleFromPrompt imported from @/shared/utils/text


type SessionStoreOptions = {
  sessionTTL?: number;
  onSessionRemove?: (session: SessionState, reason: 'explicit' | 'ttl') => Promise<void> | void;
  persistence?: SessionPersistenceDeps;
  persistenceService?: SessionPersistenceService;
  sessionRepository?: SessionRepositoryPort;
  sessionEventJournal?: SessionEventJournalPort;
  workspaceManager: WorkspaceManager;
  traceRecorder?: SessionTraceRecorder;
  toolSchemaProvider?: () => Array<{ name: string }>;
  verboseLogging?: boolean;
  onPersistError?: (info: {
    sessionId: string;
    stage: 'session' | 'metadata' | 'message' | 'checkpoint';
    error: Error;
    attempt?: number;
  }) => void;
  hydrationOptions?: HydrationOptions;
};

export type RunWorkspaceCleanupResult = {
  cleaned: boolean;
  workspaceDirs: string[];
  activeSessionIds: string[];
  errors: number;
  skippedReason?: 'missing_run_id' | 'active_sessions';
};

export type RunWorkspaceCleanupOptions = {
  reason?: string;
  force?: boolean;
  persist?: boolean;
};

export class SessionStore {
  private readonly logger = appLogger.child({ scope: 'SessionStore' });
  private readonly cache: SessionStateCache;
  private readonly persistence: SessionPersistenceAdapter;
  private readonly sessionTTL: number;
  private onSessionRemove?: (session: SessionState, reason: 'explicit' | 'ttl') => Promise<void> | void;
  private hydrationPromise?: Promise<void>;
  private readonly workspaceManager: WorkspaceManager;
  private readonly traceRecorder?: SessionTraceRecorder;
  private toolSchemaProvider?: () => Array<{ name: string }>;
  private readonly onPersistError?: SessionStoreOptions['onPersistError'];
  private readonly hydrationOptions?: HydrationOptions;
  private readonly verboseLogging: boolean;
  private readonly liveToolPersistAt = new Map<string, number>();
  // Extracted services
  private readonly cleanupService: SessionCleanupService;
  private readonly checkpointService: CheckpointStoreService;
  private readonly turnManagementService: TurnManagementService;
  private readonly lifecycleService: SessionLifecycleService;
  private readonly journalService?: SessionJournalService;
  private readonly sessionRepository?: SessionRepositoryPort;

  constructor(options: SessionStoreOptions) {
    this.sessionTTL = options.sessionTTL ?? 120 * 60 * 1000; // 2 hours default
    this.onSessionRemove = options.onSessionRemove;
    if (!options.workspaceManager) {
      throw new Error('[SessionStore] workspaceManager is required (inject an adapter).');
    }
    this.workspaceManager = options.workspaceManager;
    this.traceRecorder = options.traceRecorder;
    this.toolSchemaProvider = options.toolSchemaProvider;
    this.onPersistError = options.onPersistError;
    this.hydrationOptions = options.hydrationOptions;
    this.verboseLogging = options.verboseLogging ?? false;
    this.journalService = options.sessionEventJournal
      ? new SessionJournalService(options.sessionEventJournal)
      : undefined;
    const sessionRepository =
      options.sessionRepository ??
      options.persistenceService ??
      (options.persistence
        ? new SessionPersistenceService(options.persistence, { verboseLogging: this.verboseLogging })
        : undefined);
    this.sessionRepository = sessionRepository;
    this.cache = new SessionStateCache(this.logger);
    const ensureWorkspace = async (dir: string, ownerId?: string) => {
      await this.workspaceManager.ensureWorkspace(dir, ownerId);
    };
    this.persistence = new SessionPersistenceAdapter({
      sessions: this.cache.getStore(),
      sessionRepository,
      logger: this.logger,
      onPersistError: this.onPersistError,
      hydrationOptions: this.hydrationOptions,
      ensureWorkspace,
    });
    if (sessionRepository) {
      this.hydrationPromise = this.persistence.startHydration();
    }
    // DB is now source of truth, no cache invalidation needed
    this.lifecycleService = SessionLifecycleService.forStore({
      cleanupPort: this.createCleanupPort(),
      checkpointPort: this.createCheckpointPort(),
      sessionTTL: this.sessionTTL,
    });
    this.cleanupService = this.lifecycleService.cleanupService!;
    this.checkpointService = this.lifecycleService.checkpointService!;
    this.lifecycleService.startLocal();
    // Initialize extracted TurnManagementService with this store as the port
    this.turnManagementService = new TurnManagementService(this.createTurnManagementPort(), this.logger);
  }

  private deriveTraceContext(session: SessionState): Partial<SessionTraceSeed> {
    const securityops = isPlainRecord(session.flags?.securityops) ? session.flags.securityops : undefined;
    const subscription = isPlainRecord(session.flags?.subscription) ? session.flags.subscription : undefined;
    const taskVars = isPlainRecord(session.task?.vars) ? session.task.vars : undefined;
    const workerTaskId =
      session.coordination?.role === 'worker'
        ? readString(session.coordination.parentTaskId) ?? readString(taskVars?.parentTaskId) ?? readString(session.task?.id)
        : undefined;

    return {
      runId: readString(securityops?.runId),
      phaseId: readString(securityops?.activePhaseId),
      workerTaskId,
      agentType: session.agentType ?? 'chat',
      agentRole: deriveTraceAgentRole(session),
      context: {
        userId: session.userId,
        tier: readString(subscription?.planSlug) ?? readString(subscription?.plan_slug),
        model: session.modelName,
        imageId: session.sandboxImage,
      },
    };
  }

  private updateTraceContextFromSession(session: SessionState): void {
    this.traceRecorder?.updateContext(session.id, this.deriveTraceContext(session));
  }

  /** Create port interface for SessionCleanupService */
  private createCleanupPort(): CleanupSessionPort {
    return {
      entries: () => this.cache.entries(),
      remove: (id: string, reason: 'explicit' | 'ttl') => this.remove(id, reason),
    };
  }

  /** Create port interface for CheckpointStoreService */
  private createCheckpointPort(): CheckpointSessionPort {
    return {
      get: (id: string) => this.cache.get(id),
      updateCheckpoint: async (sessionId: string, checkpointId: string, checkpoint: CheckpointMetadata) => {
        const updated = await this.updateSessionAsync(sessionId, async (session) => {
          session.checkpoints[checkpointId] = checkpoint;
          session.lastCheckpoint = checkpoint;
          this.queuePersistMetadata(session);
          return true;
        });
        return Boolean(updated);
      },
      updateLastCheckpoint: async (sessionId: string, checkpointId: string) => {
        return this.updateLastCheckpointAsync(sessionId, checkpointId);
      },
      queuePersistCheckpoint: (sessionId: string, metadata: CheckpointMetadata) => {
        this.queuePersistCheckpoint(sessionId, metadata);
      },
    };
  }

  /** Create port interface for TurnManagementService */
  private createTurnManagementPort(): TurnManagementPort {
    return {
      getSession: (id: string) => this.cache.get(id),
      updateSession: <T>(sessionId: string, mutator: (session: SessionState) => Promise<T> | T) =>
        this.updateSessionAsync(sessionId, mutator),
    };
  }

  private fireAndLog(label: string, promise: Promise<unknown>): void {
    promise.catch((error) => {
      this.logger.warn({ err: error }, `[SessionStore] ${label} failed`);
    });
  }

  setOnSessionRemove(handler?: (session: SessionState, reason: 'explicit' | 'ttl') => Promise<void> | void): void {
    this.onSessionRemove = handler;
  }

  async whenReady(): Promise<void> {
    if (this.hydrationPromise) {
      await this.hydrationPromise;
    }
  }

  setToolSchemaProvider(provider?: () => Array<{ name: string }>): void {
    this.toolSchemaProvider = provider;
  }

  /** Get all active session IDs for hydration purposes */
  getActiveSessionIds(): string[] {
    return Array.from(this.cache.keys());
  }

  async create(options: SessionCreateOptions = {}): Promise<SessionState> {
    const {
      userId,
      profileKey,
      promptProfile,
      extraContext,
      flags,
      scopeId,
      agentType,
      task,
      toolPolicy,
      planSeed,
      planVersionHash,
      softContextBlocks,
      sandboxProfile,
      sandboxImage,
      executionMode,
      coordination,
      workerTasks,
      workerResult,
      modelContextWindow,
      modelMaxOutputTokens,
      modelTemperature,
      modelName: rawModelName,
    } = options;
    const modelName = rawModelName?.trim();
    if (!modelName) {
      throw new Error('[SessionStore] modelName is required. Configure a default model in the database.');
    }
    const id = uuidv4();
    const runWorkspaceId = readRunIdFromFlags(flags);
    const workspaceOwnerId = runWorkspaceId ?? id;
    const workspaceDir = this.workspaceManager.allocateWorkspace(workspaceOwnerId, {
      kind: runWorkspaceId ? 'run' : 'session',
    });

    // Fail session creation if workspace cannot be prepared or is over quota.
    await this.workspaceManager.ensureWorkspace(workspaceDir, workspaceOwnerId);
    if (this.workspaceManager.enforceQuota) {
      await this.workspaceManager.enforceQuota(workspaceDir);
    }

    const session: SessionState = {
      id,
      version: 0,
      userId,
      messages: [],
      plan: Array.isArray(planSeed) ? [...planSeed] : [],
      scratchTodos: [],
      memory: MemoryManager.initialize(),
      flags: flags ? cloneFlags(flags) : {},
      workspaceDir,
      status: 'idle', // DEPRECATED: kept for backward compat
      profileKey,
      promptProfile: promptProfile ?? agentType ?? 'chat',
      extraContext,
      scopeId,
      agentType: agentType ?? 'chat',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 0,
      checkpoints: {},
      currentTurn: undefined,
      task,
      toolPolicy,
      softContextBlocks,
      planVersionHash,
      sandboxProfile,
      sandboxImage,
      mode: options.mode ?? 'automated',
      executionMode,
      coordination: coordination ? JSON.parse(JSON.stringify(coordination)) as SessionCoordination : undefined,
      workerTasks: Array.isArray(workerTasks) ? JSON.parse(JSON.stringify(workerTasks)) as WorkerTaskRecord[] : [],
      workerResult: workerResult ? JSON.parse(JSON.stringify(workerResult)) as WorkerResultArtifact : undefined,
      liveToolStreams: {},
      timeline: [],
      // Model context configuration (wired from DB)
      modelName,
      modelContextWindow,
      modelMaxOutputTokens,
      modelTemperature,
      // Phase 2: State machine for centralized state management
      stateMachine: undefined, // Initialized below after session is created
    };

    // Phase 2: Initialize state machine for centralized state management
    session.stateMachine = createSessionStateMachine(id, this.logger);
    
    this.cache.set(id, session);
    this.queuePersistSession(session, { insert: true });

    // CRITICAL FIX: Await DB persistence before trace recorder init.
    // Trace recorder inserts into trace_index with FK to agent_sessions.
    // If we don't await, the session may not exist in DB when trace writes.
    await this.waitForSessionPersisted(id);

    if (this.journalService) {
      try {
        await this.journalService.append(id, [
          {
            idempotencyKey: 'session.created',
            event: {
              eventType: 'session.created',
              payload: {
                modelName,
                mode: session.mode ?? 'automated',
                desiredExecution: 'running',
              },
            },
          },
          ...(session.plan.length > 0 ? [{
            idempotencyKey: 'session.initial-plan',
            event: {
              eventType: 'plan.changed' as const,
              payload: { plan: session.plan },
            },
          }] : []),
        ]);
      } catch (error) {
        this.cache.delete(id);
        await this.persistence.deleteSession(id).catch((deleteError) => {
          this.logger.error(
            { err: deleteError, sessionId: id },
            'Failed to roll back a session whose journal could not be initialized',
          );
        });
        throw error;
      }
    }

    const recorder = this.traceRecorder;
    if (recorder) {
      const toolNames =
        this.toolSchemaProvider?.().map((tool) => tool.name) ?? [];
      const traceContext = this.deriveTraceContext(session);
      recorder
        .init(id, {
          workspace: workspaceDir,
          tools: toolNames,
          profileKey,
          promptProfile: session.promptProfile,
          agentType: session.agentType ?? 'chat',
          agentRole: traceContext.agentRole,
          runId: traceContext.runId,
          phaseId: traceContext.phaseId,
          workerTaskId: traceContext.workerTaskId,
          extraContext: Boolean(extraContext),
          model: session.modelName ?? 'unknown',
          sandboxProfile: sandboxProfile ?? null,
          container: sandboxImage ? { image: sandboxImage } : undefined,
          // Business context for high-cardinality analytics
          context: traceContext.context,
        })
        .catch((error) => {
          this.logger.warn({ err: error, sessionId: id }, 'Failed to initialize trace for session');
        });
    }

    return session;
  }

  async assignRunWorkspaceAsync(
    sessionId: string,
    runId: string,
    source = 'run.workspace.assigned',
  ): Promise<SessionState | undefined> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      throw new Error('[SessionStore] runId is required for run workspace assignment.');
    }

    const workspaceDir = this.workspaceManager.allocateWorkspace(normalizedRunId, { kind: 'run' });
    await this.workspaceManager.ensureWorkspace(workspaceDir, normalizedRunId);

    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      const securityops = isPlainRecord(session.flags?.securityops) ? session.flags.securityops : {};
      const alreadyAssigned =
        session.workspaceDir === workspaceDir &&
        readString(securityops.runId) === normalizedRunId;
      if (alreadyAssigned) {
        return session;
      }
      session.workspaceDir = workspaceDir;
      session.flags = {
        ...(session.flags ?? {}),
        securityops: {
          ...securityops,
          runId: normalizedRunId,
        },
      };
      if (this.traceRecorder) {
        await this.traceRecorder.write(sessionId, session.turn ?? 0, {
          event: 'workspace.run_scoped_assigned',
          severity: 'info',
          payload: { runId: normalizedRunId, workspace: workspaceDir, source },
          note: `workspace=ns-run-${normalizedRunId}`,
        }).catch((error) => {
          this.logger.warn({ err: error, sessionId, runId: normalizedRunId }, 'Failed to record run workspace assignment');
        });
      }
      return session;
    });

    return updated ? this.get(sessionId) : undefined;
  }

  get(sessionId: string): SessionState | undefined {
    const session = this.cache.get(sessionId);
    if (session) {
      if (!session.flags) {
        session.flags = {};
      }
      session.lastActive = Date.now();
      this.turnManagementService.attachCurrentTurn(sessionId, session);
    }
    if (!session) {
      void this.hydrateIfMissing(sessionId);
    }
    return session;
  }

  /**
   * Get a session from memory or hydrate it from persistence on-demand.
   *
   * This enables "cold" sessions (evicted due to TTL or not loaded at startup)
   * to be reconstructed and started without returning a false "not found".
   */
  async getOrHydrate(sessionId: string): Promise<SessionState | undefined> {
    const existing = this.get(sessionId);
    if (existing) {
      return existing;
    }

    // Hydration is best-effort; if the session doesn't exist in DB this will no-op.
    await this.persistence.hydrateIfMissing(sessionId);
    return this.get(sessionId);
  }

  listByUser(userId?: string): SessionState[] {
    if (!userId) return [];
    return Array.from(this.cache.values()).filter((s) => s.userId === userId);
  }

  listByRunId(runId?: string): SessionState[] {
    const normalizedRunId = runId?.trim();
    if (!normalizedRunId) return [];
    return Array.from(this.cache.values()).filter((session) => readRunIdFromFlags(session.flags) === normalizedRunId);
  }

  async cleanupRunWorkspaceAsync(
    runId: string,
    options: RunWorkspaceCleanupOptions = {},
  ): Promise<RunWorkspaceCleanupResult> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) {
      return {
        cleaned: false,
        workspaceDirs: [],
        activeSessionIds: [],
        errors: 0,
        skippedReason: 'missing_run_id',
      };
    }

    const runSessions = this.listByRunId(normalizedRunId);
    const activeSessionIds = runSessions
      .filter(isSessionActiveForRunWorkspace)
      .map((session) => session.id);
    if (!options.force && activeSessionIds.length > 0) {
      return {
        cleaned: false,
        workspaceDirs: [],
        activeSessionIds,
        errors: 0,
        skippedReason: 'active_sessions',
      };
    }

    const workspaceDirs = new Set<string>();
    for (const session of runSessions) {
      if (session.workspaceDir?.trim()) {
        workspaceDirs.add(session.workspaceDir);
      }
    }
    if (workspaceDirs.size === 0) {
      workspaceDirs.add(this.workspaceManager.allocateWorkspace(normalizedRunId, { kind: 'run' }));
    }

    let errors = 0;
    const persistOwnerId = options.persist === false ? undefined : normalizedRunId;
    for (const workspaceDir of workspaceDirs) {
      try {
        await this.workspaceManager.cleanupWorkspace(workspaceDir, persistOwnerId);
      } catch (error) {
        errors += 1;
        this.logger.warn(
          {
            err: error,
            runId: normalizedRunId,
            workspaceDir,
            reason: options.reason,
          },
          'Failed to clean up run workspace',
        );
      }
    }

    return {
      cleaned: errors === 0,
      workspaceDirs: [...workspaceDirs],
      activeSessionIds,
      errors,
    };
  }

  setMemory(sessionId: string, memory: Record<string, unknown>): boolean {
    this.fireAndLog('setMemory', this.setMemoryAsync(sessionId, memory));
    return true;
  }

  set(sessionId: string, state: SessionState): void {
    this.fireAndLog('set', this.setAsync(sessionId, state, 'set'));
  }

  appendMessage(sessionId: string, message: Message): boolean {
    this.fireAndLog('appendMessage', this.appendMessageAsync(sessionId, message));
    return true;
  }

  addCheckpoint(sessionId: string, metadata: CheckpointMetadata): boolean {
    this.fireAndLog('addCheckpoint', this.addCheckpointAsync(sessionId, metadata));
    return true;
  }

  getCheckpoint(sessionId: string, checkpointId: string): CheckpointMetadata | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;
    return session.checkpoints[checkpointId];
  }

  listCheckpoints(sessionId: string): CheckpointMetadata[] {
    const session = this.get(sessionId);
    if (!session) return [];
    return Object.values(session.checkpoints).sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }

  updateLastCheckpoint(sessionId: string, checkpointId: string): CheckpointMetadata | undefined {
    this.fireAndLog('updateLastCheckpoint', this.updateLastCheckpointAsync(sessionId, checkpointId));
    return undefined;
  }

  startTurn(sessionId: string, controller: AbortController, metadata?: { reason?: string }): boolean {
    this.fireAndLog('startTurn', this.startTurnAsync(sessionId, controller, metadata));
    return true;
  }

  clearCurrentTurn(sessionId: string): void {
    this.fireAndLog('clearCurrentTurn', this.clearCurrentTurnAsync(sessionId));
  }

  updateStatus(sessionId: string, status: SessionState['status']): void {
    this.fireAndLog('updateStatus', this.updateStatusAsync(sessionId, status));
  }

  getCurrentTurn(sessionId: string): SessionState['currentTurn'] | undefined {
    return this.turnManagementService.getCurrentTurn(sessionId);
  }

  markAbortEventEmitted(sessionId: string, reason?: string): void {
    this.fireAndLog('markAbortEventEmitted', this.markAbortEventEmittedAsync(sessionId, reason));
  }

  updatePlanStep(sessionId: string, stepId: string, step: PlanItem): PlanItem[] {
    this.fireAndLog('updatePlanStep', this.updatePlanStepAsync(sessionId, stepId, step));
    return [];
  }

  updatePlan(sessionId: string, plan: PlanItem[]): boolean {
    this.fireAndLog('updatePlan', this.updatePlanAsync(sessionId, plan));
    return true;
  }

  getFlags(sessionId: string): SessionFlags {
    const session = this.get(sessionId);
    return session ? cloneFlags(session.flags) : {};
  }

  setFlag(sessionId: string, flagPath: string, value: unknown): boolean {
    this.fireAndLog('setFlag', this.setFlagAsync(sessionId, flagPath, value));
    return true;
  }

  mergeFlagNamespace(
    sessionId: string,
    namespace: string,
    values: Record<string, unknown>
  ): boolean {
    this.fireAndLog('mergeFlagNamespace', this.mergeFlagNamespaceAsync(sessionId, namespace, values));
    return true;
  }

  clearFlags(sessionId: string): boolean {
    this.fireAndLog('clearFlags', this.clearFlagsAsync(sessionId));
    return true;
  }

  listSessions(): SessionState[] {
    return Array.from(this.cache.values()).map((session) => cloneSession(session));
  }

  /**
   * Alias for listSessions to support lifecycle services.
   */
  listAll(): SessionState[] {
    return this.listSessions();
  }

  // cloneSession, cloneFlags, parseFlagPath now imported from ./helpers/SessionUtils

  remove(sessionId: string, reason: 'explicit' | 'ttl' = 'explicit'): boolean {
    this.fireAndLog('remove', this.removeAsync(sessionId, reason));
    return true;
  }

  private async removeInternal(sessionId: string, reason: 'explicit' | 'ttl' = 'explicit'): Promise<boolean> {
    const session = this.cache.get(sessionId);
    if (!session) return false;

    await this.triggerSessionRemove(session, reason);
    this.turnManagementService.clearCurrentTurnState(sessionId);
    this.liveToolPersistAt.delete(sessionId);
    const runWorkspaceId = readRunIdFromFlags(session.flags);
    if (!runWorkspaceId) {
      void this.workspaceManager.cleanupWorkspace(session.workspaceDir, session.id).catch((error) => {
        this.logger.warn({ err: error, sessionId }, 'Failed to clean up workspace for session');
      });
    }

    const recorder = this.traceRecorder;
    if (recorder) {
      await recorder
        .write(sessionId, session.turn, {
          event: 'session.cleanup',
          severity: 'info',
          payload: { reason },
          note: `reason=${reason}`,
        })
        .catch((error) => {
          this.logger.warn({ err: error, sessionId }, 'Failed to record cleanup event for session');
        });

      await recorder
        .close(sessionId, {
          terminal: reason === 'explicit' ? 'session.cleanup' : 'session.cleanup',
          status: session.status,
          turns: session.turn,
        })
        .catch((error) => {
          this.logger.warn({ err: error, sessionId }, 'Failed to close trace for session');
        });
    }

    // Only delete from database on EXPLICIT removal (user/admin action).
    // TTL eviction only clears from in-memory cache - sessions persist in DB
    // so users can access historical reports after memory eviction.
    if (reason === 'explicit') {
      void this.persistence.deleteSession(sessionId)
        .catch((error: unknown) =>
          this.logger.error({ err: error, sessionId }, '[SessionStore] Failed to delete session from persistence'),
        );
    }

    return this.cache.delete(sessionId);
  }

  private async hydrateIfMissing(sessionId: string): Promise<void> {
    await this.persistence.hydrateIfMissing(sessionId);
  }



  private queuePersistSession(session: SessionState, options: { insert?: boolean } = {}): void {
    this.persistence.queuePersistSession(session, options);
  }

  /**
   * Queue metadata persistence for a session.
   * This persists usage, flags, and other session metadata to DB.
   * Called from TurnRunner after each turn to ensure data survives backend restarts.
   */
  queuePersistMetadata(session: SessionState): void {
    this.persistence.queuePersistMetadata(session);
  }

  private queuePersistMessage(sessionId: string, message: Message): void {
    this.persistence.queuePersistMessage(sessionId, message);
  }

  private queuePersistCheckpoint(sessionId: string, metadata: CheckpointMetadata): void {
    this.persistence.queuePersistCheckpoint(sessionId, metadata);
  }

  async waitForSessionPersisted(sessionId: string): Promise<void> {
    await this.persistence.waitForSessionPersisted(sessionId);
  }

  async waitForSessionMetadataPersisted(sessionId: string): Promise<void> {
    await this.persistence.waitForMetadataPersisted(sessionId);
  }

  // DB is now source of truth, no cache refresh needed
  // Persist error handling and serialization now in SessionPersistenceHelper

  // RedisLock was a second authority that could cause split-brain scenarios.
  // SessionStore now relies on in-process locking plus durable session fields only.

  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.cache.withLock(sessionId, fn);
  }

  async updateSessionAsync<T>(
    sessionId: string,
    mutator: (session: SessionState) => Promise<T> | T,
  ): Promise<T | undefined> {
    return this.cache.updateSession(sessionId, mutator, {
      afterUpdate: (session) => {
        this.updateTraceContextFromSession(session);
        this.queuePersistSession(session);
      },
      context: 'updateSessionAsync',
    });
  }

  /**
   * Set session state asynchronously.
   *
   * @param sessionId - Session ID to update
   * @param state - New session state
   * @param source - Source of the write (for debugging)
   */
  async setAsync(
    sessionId: string,
    state: SessionState,
    source: string = 'unknown',
  ): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const existing = this.cache.get(sessionId);
      if (
        existing &&
        typeof state.version === 'number' &&
        typeof existing.version === 'number' &&
        state.version < existing.version
      ) {
        const payload = {
          sessionId,
          source,
          incomingVersion: state.version,
          currentVersion: existing.version,
        };
        if (this.verboseLogging) {
          this.logger.debug(payload, '[SessionStore][setAsync] ignored stale write');
        } else {
          this.logger.trace?.(payload, '[SessionStore][setAsync] ignored stale write');
        }
        return;
      }

      // Runtime guard: warn on direct status writes outside FSM
      if (existing && existing.status !== state.status && source !== 'fsm.transition') {
        this.logger.warn(
          {
            sessionId,
            source,
            previousStatus: existing.status,
            newStatus: state.status,
          },
          '[SessionStore][setAsync] WARN: Direct status write bypassed FSM. Use SessionStateMachine.transition() instead.',
        );
        // Log stack trace in debug mode for finding offending code
        if (this.verboseLogging) {
          this.logger.debug({ stack: new Error().stack }, '[SessionStore][setAsync] Direct status write stack trace');
        }
      }

      const next: SessionState = {
        ...state,
        flags: state.flags ?? {},
        lastActive: Date.now(),
        version: (state.version ?? existing?.version ?? 0) + 1,
      };

      // CRITICAL FIX: Always preserve the existing messages array REFERENCE.
      // The spread operator creates a new array, which detaches any in-progress
      // appendMessagesAsync operations that are pushing to the old array.
      // This was causing message duplication because:
      // 1. appendMessagesAsync gets session reference and starts pushing
      // 2. setAsync runs concurrently, creates NEW session with NEW messages array
      // 3. appendMessagesAsync finishes pushing to the OLD (now detached) array
      // 4. Next iteration re-pushes the same messages to the NEW array
      //
      // By always using the existing messages array, we ensure all concurrent
      // operations push to the same array and no messages are duplicated.
      if (existing && Array.isArray(existing.messages)) {
        // Always use the existing messages array - it's the live reference
        // that appendMessagesAsync operations are pushing to
        next.messages = existing.messages;
      }

      this.cache.set(sessionId, next);
      this.updateTraceContextFromSession(next);
      this.queuePersistSession(next);
    });
  }


  async setMemoryAsync(sessionId: string, memory: Record<string, unknown>): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      session.memory = MemoryManager.fromRecord(memory);
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async appendMessageAsync(sessionId: string, message: Message): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      session.messages.push(message);
      if (
        !session.title &&
        !session.task?.title &&
        message.role === 'user' &&
        message.metadata?.visibility !== 'internal'
      ) {
        const derivedTitle = deriveTitleFromPrompt(message.content);
        if (derivedTitle) {
          session.title = derivedTitle;
        }
      }
      // Journal-backed sessions project accepted messages transactionally in
      // the journal adapter. Legacy/no-journal hosts keep the old writer.
      if (!this.journalService) this.queuePersistMessage(sessionId, message);
      return true;
    });
    return Boolean(updated);
  }

  private async ensureJournalInitialized(
    session: SessionState,
    desiredExecution: 'running' | 'stopped' = 'running',
  ): Promise<void> {
    if (!this.journalService) return;
    const fold = await this.journalService.fold(session.id);
    if (fold.created) return;
    if (fold.lastSequence !== 0) {
      throw new Error(
        `Session ${session.id} has journal events but no valid creation/import boundary.`,
      );
    }
    await this.journalService.append(session.id, [
      {
        idempotencyKey: 'legacy.session_imported',
        event: {
          eventType: 'legacy.session_imported',
          payload: {
            desiredExecution,
            messages: session.messages,
            turn: session.turn,
            source: 'agent_messages_projection',
          },
        },
      },
      ...(session.plan.length > 0 ? [{
        idempotencyKey: 'legacy.initial-plan',
        event: {
          eventType: 'plan.changed' as const,
          payload: { plan: session.plan },
        },
      }] : []),
    ]);
  }

  /** Durable input and turn boundary; called before model execution. */
  async beginJournalTurnAsync(
    sessionId: string,
    turnNumber: number,
    inputMessage?: Message,
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    const turnId = `turn-${turnNumber}`;
    const existing = await this.journalService.fold(sessionId);
    if (existing.openTurnId) {
      if (inputMessage || existing.openTurnId !== turnId) {
        throw new Error(
          `Cannot begin ${turnId}: journal turn ${existing.openTurnId} is still open.`,
        );
      }
      // Recovery is continuing the exact durable turn. Its start boundary is
      // already authoritative and must not be appended a second time.
      return;
    }
    const inputMessageIds = inputMessage
      ? [inputMessage.id]
      : existing.pendingInputMessageIds;
    await this.journalService.append(sessionId, [
      ...(inputMessage ? [{
        idempotencyKey: `input:${inputMessage.id}`,
        event: {
          eventType: 'input.accepted' as const,
          payload: { message: inputMessage },
          correlationId: turnId,
        },
      }] : []),
      {
        idempotencyKey: `turn:${turnId}:started`,
        event: {
          eventType: 'turn.started',
          payload: {
            turnId,
            turnNumber,
            inputMessageIds,
          },
          correlationId: turnId,
        },
      },
    ]);
  }

  /** Durable assembled model response and requested tools; commits before tool dispatch. */
  async recordModelResponseAcceptedAsync(
    sessionId: string,
    turnNumber: number,
    modelRequestId: string | undefined,
    message: Message,
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    const turnId = `turn-${turnNumber}`;
    const requestId = modelRequestId?.trim() || `unavailable:${message.id}`;
    await this.journalService.append(sessionId, [
      ...(!modelRequestId ? [{
        idempotencyKey: `model-request-missing:${message.id}`,
        event: {
          eventType: 'session.data_loss_detected' as const,
          payload: {
            kind: 'missing_projection' as const,
            detail: `Model response ${message.id} has no durable model request ID.`,
          },
          correlationId: turnId,
        },
      }] : []),
      {
        idempotencyKey: `model-response:${requestId}:${message.id}`,
        event: {
          eventType: 'model.response.accepted',
          payload: { turnId, modelRequestId: requestId, message },
          correlationId: turnId,
        },
      },
      ...(message.tool_calls ?? []).map((toolCall) => ({
        idempotencyKey: `tool-request:${toolCall.id}`,
        event: {
          eventType: 'tool.requested' as const,
          payload: {
            turnId,
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            modelRequestId: requestId,
            arguments: toolCall.function.arguments,
          },
          correlationId: turnId,
        },
      })),
    ]);
  }

  /** Attach only terminal tool results after their effect-ledger settlement. */
  async recordToolOutcomesAcceptedAsync(
    sessionId: string,
    turnNumber: number,
    messages: readonly Message[],
    options: { awaitingApprovalIsSucceeded?: boolean } = {},
  ): Promise<void> {
    if (!this.journalService) return;
    const terminal = messages.flatMap((message) => {
      const receipt = message.metadata?.toolExecution;
      const toolCallId = message.toolCallId ?? message.tool_call_id ?? receipt?.toolCallId;
      if (message.role !== 'tool' || !receipt || !toolCallId) {
        return [];
      }
      if (receipt.outcome === 'awaiting_approval' && !options.awaitingApprovalIsSucceeded) {
        return [];
      }
      const outcome: SessionToolOutcome = receipt.outcome === 'succeeded'
        || (receipt.outcome === 'awaiting_approval' && options.awaitingApprovalIsSucceeded)
        ? 'succeeded'
        : receipt.outcome === 'blocked' || receipt.outcome === 'skipped'
          ? 'blocked'
          : receipt.outcome === 'interrupted'
            ? 'outcome_unknown'
            : 'failed';
      const turnId = `turn-${turnNumber}`;
      const acceptedMessage = receipt.outcome === 'awaiting_approval'
        ? {
          ...message,
          metadata: {
            ...message.metadata,
            toolExecution: { ...receipt, outcome: 'succeeded' as const },
          },
        }
        : message;
      return [{
        idempotencyKey: `tool-outcome:${toolCallId}`,
        event: {
          eventType: 'tool.outcome_attached' as const,
          payload: { turnId, toolCallId, outcome, message: acceptedMessage },
          correlationId: turnId,
        },
      }];
    });
    if (terminal.length > 0) await this.journalService.append(sessionId, terminal);
  }

  async recordApprovalRequestedAsync(
    sessionId: string,
    turnNumber: number,
    approval: { actionId: string; toolCallId: string },
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    const turnId = `turn-${turnNumber}`;
    await this.journalService.append(sessionId, [{
      idempotencyKey: `approval:${approval.actionId}:requested`,
      event: {
        eventType: 'approval.requested',
        payload: { turnId, toolCallId: approval.toolCallId, actionId: approval.actionId },
        correlationId: turnId,
      },
    }]);
  }

  async recordApprovalDecidedAsync(
    sessionId: string,
    actionId: string,
    decision: 'granted' | 'denied',
    reason?: string,
    approval?: { toolCallId: string; toolName: string; turnNumber: number; requestedAt?: number },
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    const acceptedToolCallTimestamp = approval
      ? [...session.messages].reverse().find((message) =>
        message.role === 'assistant'
        && message.tool_calls?.some((toolCall) => toolCall.id === approval.toolCallId))?.timestamp
      : undefined;
    const approvalBoundaryTimestamp = approval?.requestedAt
      ?? (acceptedToolCallTimestamp !== undefined ? acceptedToolCallTimestamp + 1 : 0);
    const deniedMessage: Message | undefined = decision === 'denied' && approval
      ? {
        id: `approval-denied-${actionId}`,
        role: 'tool',
        toolCallId: approval.toolCallId,
        tool_call_id: approval.toolCallId,
        // Approval command retries reproduce the same timestamp from the
        // durable request boundary while timestamp-sorted views retain order.
        timestamp: approvalBoundaryTimestamp,
        content: JSON.stringify({
          error: reason ?? 'Action denied by operator.',
          outcome: 'blocked',
        }),
        metadata: {
          toolExecution: {
            schema: 'tool-execution-receipt/v1',
            toolName: approval.toolName,
            toolCallId: approval.toolCallId,
            outcome: 'blocked',
          },
        },
      }
      : undefined;
    await this.journalService.append(sessionId, [
      {
        idempotencyKey: `approval:${actionId}:decided`,
        event: {
          eventType: 'approval.decided',
          payload: { actionId, decision, ...(reason ? { reason } : {}) },
          correlationId: actionId,
        },
      },
      ...(deniedMessage && approval ? [{
        idempotencyKey: `tool-outcome:${approval.toolCallId}`,
        event: {
          eventType: 'tool.outcome_attached' as const,
          payload: {
            turnId: `turn-${approval.turnNumber}`,
            toolCallId: approval.toolCallId,
            outcome: 'blocked' as const,
            message: deniedMessage,
          },
          correlationId: `turn-${approval.turnNumber}`,
        },
      }] : []),
    ], { nextAttemptAt: new Date() });
  }

  async finishJournalTurnAsync(
    sessionId: string,
    turnNumber: number,
    result: 'completed' | 'interrupted',
    reason: string,
  ): Promise<void> {
    if (!this.journalService) return;
    const turnId = `turn-${turnNumber}`;
    await this.journalService.append(sessionId, [{
      idempotencyKey: `turn:${turnId}:closed`,
      event: result === 'completed'
        ? {
          eventType: 'turn.completed',
          payload: { turnId, reason },
          correlationId: turnId,
        }
        : {
          eventType: 'turn.interrupted',
          payload: { turnId, reason, source: 'runtime' },
          correlationId: turnId,
        },
    }], result === 'interrupted'
      ? {
          // Do not replace a closeout, prerequisite, or provider backoff that
          // was durably scheduled earlier in the same turn.
          nextAttemptAt: new Date(),
          updateMode: 'if_missing',
        }
      : undefined);
  }

  async getJournalProjection(sessionId: string): Promise<SessionJournalFold | undefined> {
    return this.journalService?.fold(sessionId);
  }

  private liveExecutionCoordinationFacts(
    sessionId: string,
  ): SessionExecutionCoordinationFacts | null {
    const session = this.cache.get(sessionId);
    if (!session) return null;
    return {
      sessionId,
      completed: session.completed === true || readSessionCompletedFromFlags(session.flags),
      blockedReason: session.blockedReason ?? null,
      nextAttemptAt: null,
      executionClaimToken: null,
      executionClaimExpiresAt: null,
    };
  }

  async getExecutionReadModel(
    sessionId: string,
    now: Date = new Date(),
  ): Promise<SessionExecutionReadModel | undefined> {
    return (await this.getExecutionReadModels([sessionId], now)).get(sessionId);
  }

  async getExecutionReadModels(
    sessionIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, SessionExecutionReadModel>> {
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (ids.length === 0) return new Map();
    const [folds, coordinationRows] = await Promise.all([
      this.journalService?.foldMany(ids) ?? Promise.resolve(new Map<string, SessionJournalFold>()),
      this.sessionRepository?.getExecutionCoordinationFactsMany?.(ids)
        ?? Promise.resolve(ids.flatMap((id) => {
          const facts = this.liveExecutionCoordinationFacts(id);
          return facts ? [facts] : [];
        })),
    ]);
    const coordinationById = new Map(
      coordinationRows.map((facts) => [facts.sessionId, facts]),
    );
    const projected = new Map<string, SessionExecutionReadModel>();
    for (const sessionId of ids) {
      const coordination = coordinationById.get(sessionId)
        ?? this.liveExecutionCoordinationFacts(sessionId);
      if (!coordination) continue;
      const fold = folds.get(sessionId);
      projected.set(
        sessionId,
        fold?.created
          ? projectSessionExecutionReadModel({ fold, coordination }, now)
          : projectLegacySessionExecutionReadModel(coordination, now),
      );
    }
    return projected;
  }

  /** Rebuild the mutable runtime cache from the canonical journal projection. */
  async applyJournalProjectionAsync(
    sessionId: string,
    projection?: SessionJournalFold,
  ): Promise<SessionState | undefined> {
    if (!this.journalService) return this.cache.get(sessionId);
    const fold = projection ?? await this.journalService.fold(sessionId);
    if (fold.issues.length > 0) {
      throw new Error(
        `Cannot apply degraded journal projection for ${sessionId}: ${fold.issues[0]?.detail ?? 'unknown issue'}`,
      );
    }
    return this.updateSessionAsync(sessionId, async (session) => {
      session.messages = fold.messages.map((message) => ({ ...message }));
      session.plan = fold.plan.map((item) => ({ ...item }));
      const durableTurnNumber = fold.openTurnNumber ?? fold.interruptedTurn?.turnNumber;
      if (durableTurnNumber !== undefined) {
        session.turn = durableTurnNumber;
      }
      return session;
    });
  }

  async ensureJournalForRecoveryAsync(sessionId: string): Promise<SessionJournalFold | undefined> {
    if (!this.journalService) return undefined;
    const session = (await this.getOrHydrate(sessionId)) ?? this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    // A pre-journal session can still carry an explicit Stop in its durable
    // compatibility projection. Preserve that intent at the one-time import
    // boundary; an expired execution lease must never turn Stop into Start.
    const desiredExecution = session.blockedReason === 'user_paused'
      || session.blockedReason === 'aborted_by_user'
      ? 'stopped'
      : 'running';
    await this.ensureJournalInitialized(session, desiredExecution);
    return this.journalService.fold(sessionId);
  }

  async recordPlanChangedAsync(sessionId: string, plan: PlanItem[]): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      event: {
        eventType: 'plan.changed',
        payload: { plan },
      },
    }]);
  }

  async recordExecutionDeferredAsync(
    sessionId: string,
    reason: string,
    retryAt: Date,
    idempotencyKey: string,
    executionClaimToken?: string,
    block?: {
      reason: string;
      meta?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    if (!this.journalService) return false;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      idempotencyKey,
      event: {
        eventType: 'execution.deferred',
        payload: { reason, retryAt: retryAt.toISOString() },
      },
    }], {
      nextAttemptAt: retryAt,
      ...(block ? { blockedReason: block.reason, blockedMeta: block.meta } : {}),
      ...(executionClaimToken ? { expectedExecutionClaimToken: executionClaimToken } : {}),
    });
    return true;
  }

  async recordCloseoutRequestedAsync(
    sessionId: string,
    reason: string,
    retryAt: Date,
    attemptId: string,
    executionClaimToken?: string,
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      idempotencyKey: `closeout:requested:${attemptId}:${reason}`,
      event: {
        eventType: 'closeout.requested',
        payload: { reason },
        correlationId: 'closeout',
      },
    }], {
      nextAttemptAt: retryAt,
      ...(executionClaimToken ? { expectedExecutionClaimToken: executionClaimToken } : {}),
    });
  }

  async recordCloseoutCompletedAsync(
    sessionId: string,
    reason = 'reconciled',
    executionClaimToken?: string,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      idempotencyKey: `closeout:completed:turn-${session.turn ?? 0}`,
      event: {
        eventType: 'closeout.completed',
        payload: { reason },
        correlationId: 'closeout',
      },
    }], {
      nextAttemptAt: null,
      completeSession: true,
      ...(executionClaimToken ? { expectedExecutionClaimToken: executionClaimToken } : {}),
    });
    return true;
  }

  async recordSessionCompletedAsync(
    sessionId: string,
    reason: string,
    executionClaimToken?: string,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      idempotencyKey: `session:completed:turn-${session.turn ?? 0}:${reason}`,
      event: {
        eventType: 'session.completed',
        payload: { reason },
      },
    }], {
      nextAttemptAt: null,
      completeSession: true,
      ...(executionClaimToken ? { expectedExecutionClaimToken: executionClaimToken } : {}),
    });
    return true;
  }

  async recordCompactionAppliedAsync(
    sessionId: string,
    transactionId: string,
    throughMessageId: string,
    summaryMessage: Message,
  ): Promise<void> {
    if (!this.journalService) return;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'running');
    await this.journalService.append(sessionId, [{
      idempotencyKey: `compaction:${transactionId}:applied`,
      event: {
        eventType: 'compaction.applied',
        payload: {
          transactionId,
          throughMessageId,
          summaryMessage,
        },
        correlationId: transactionId,
      },
    }]);
  }

  async recordStopRequestedAsync(
    sessionId: string,
    reason?: string,
    requestedBy?: string,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'stopped');
    const requestedAt = new Date();
    await this.journalService.append(sessionId, [{
      event: {
        eventType: 'session.stop_requested',
        payload: {
          ...(reason ? { reason } : {}),
          ...(requestedBy ? { requestedBy } : {}),
        },
        createdAt: requestedAt,
      },
    }], {
      nextAttemptAt: null,
      revokeExecutionClaim: true,
      blockedReason: 'user_paused',
      blockedMeta: {
        stoppedAt: requestedAt.toISOString(),
        ...(requestedBy ? { stoppedBy: requestedBy } : {}),
        ...(reason ? { reason } : {}),
      },
    });
    return true;
  }

  async recordStartRequestedAsync(
    sessionId: string,
    reason?: string,
    requestedBy?: string,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'stopped');
    const requestedAt = new Date();
    await this.journalService.append(sessionId, [{
      event: {
        eventType: 'session.start_requested',
        payload: {
          ...(reason ? { reason } : {}),
          ...(requestedBy ? { requestedBy } : {}),
        },
        createdAt: requestedAt,
      },
    }], {
      nextAttemptAt: requestedAt,
      reopenSession: true,
      blockedReason: null,
    });

    await this.applyDurableReopenProjectionAsync(sessionId, true);
    return true;
  }

  /**
   * Accept workbench input and Start the stopped session in one journal commit.
   *
   * The continuation worker, not the HTTP process, owns the resulting turn.
   * This prevents an acknowledged message from being lost between a backend
   * restart and the old fire-and-forget orchestration call.
   */
  async recordInputAndStartRequestedAsync(
    sessionId: string,
    message: Message,
    reason?: string,
    requestedBy?: string,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    if (message.role !== 'user') {
      throw new Error('Only user messages can be accepted as session input.');
    }
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    await this.ensureJournalInitialized(session, 'stopped');
    const requestedAt = new Date();
    await this.journalService.append(sessionId, [
      {
        idempotencyKey: `input-start:${message.id}`,
        event: {
          eventType: 'session.start_requested',
          payload: {
            ...(reason ? { reason } : {}),
            ...(requestedBy ? { requestedBy } : {}),
          },
          correlationId: message.id,
          createdAt: requestedAt,
        },
      },
      {
        idempotencyKey: `input:${message.id}`,
        event: {
          eventType: 'input.accepted',
          payload: { message },
          correlationId: message.id,
          createdAt: requestedAt,
        },
      },
    ], {
      nextAttemptAt: requestedAt,
      reopenSession: true,
      blockedReason: null,
    });

    await this.applyDurableReopenProjectionAsync(sessionId, true);
    await this.applyJournalProjectionAsync(sessionId);
    return true;
  }

  /**
   * Accept system-generated model-facing input without changing user intent.
   *
   * Background worker completion is work, not an operator Start. If it races
   * with Stop, the input remains durable and pending while the folded desired
   * execution stays stopped. A later explicit Start can consume it safely.
   */
  async recordInternalContinuationInputAsync(
    sessionId: string,
    message: Message,
  ): Promise<boolean> {
    if (!this.journalService) return false;
    if (message.role !== 'user' || message.metadata?.visibility !== 'internal') {
      throw new Error('Internal continuation input must be an internal user message.');
    }
    const session = this.cache.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);
    const legacyDesiredExecution = session.blockedReason === 'user_paused'
      || session.blockedReason === 'aborted_by_user'
      ? 'stopped'
      : 'running';
    await this.ensureJournalInitialized(session, legacyDesiredExecution);
    const acceptedAt = new Date();
    await this.journalService.append(sessionId, [{
      idempotencyKey: `input:${message.id}`,
      event: {
        eventType: 'input.accepted',
        payload: { message },
        correlationId: message.id,
        createdAt: acceptedAt,
      },
    }], {
      // Preserve an existing prerequisite/backoff schedule. When Stop won the
      // race this merely triggers one no-op reconciliation; it cannot Start.
      nextAttemptAt: acceptedAt,
      updateMode: 'if_missing',
      // New accepted work reopens semantic completion without changing Stop.
      // The journal fold already makes input.accepted unfinished work, so its
      // DB projection must change in the same transaction.
      reopenSession: true,
    });
    await this.applyDurableReopenProjectionAsync(sessionId, false);
    await this.applyJournalProjectionAsync(sessionId);
    return true;
  }

  private async applyDurableReopenProjectionAsync(
    sessionId: string,
    clearBlockedReason: boolean,
  ): Promise<void> {
    // Keep the process-local projection aligned with the journal transaction.
    await this.updateSessionAsync(sessionId, async (current) => {
      const flags = { ...(current.flags ?? {}) } as Record<string, unknown>;
      const sessionFlags = flags.session && typeof flags.session === 'object' && !Array.isArray(flags.session)
        ? { ...(flags.session as Record<string, unknown>) }
        : undefined;
      if (sessionFlags) {
        delete sessionFlags.completed;
        if (Object.keys(sessionFlags).length > 0) flags.session = sessionFlags;
        else delete flags.session;
      }
      current.completed = false;
      if (clearBlockedReason) {
        current.blockedReason = undefined;
        current.blockedMeta = undefined;
      }
      current.flags = flags;
      return current;
    });
  }

  recordLiveToolStart(sessionId: string, toolName: string, command?: string): boolean {
    this.fireAndLog('recordLiveToolStart', this.recordLiveToolStartAsync(sessionId, toolName, command));
    return true;
  }

  async recordLiveToolStartAsync(
    sessionId: string,
    toolName: string,
    command?: string,
  ): Promise<boolean> {
    return this.mutateLiveToolStreamsInMemory(sessionId, (streams) => {
      streams[toolName] = {
        name: toolName,
        chunks: [],
        status: 'running',
        command,
        lastUpdated: Date.now(),
      };
    }, { forcePersist: true });
  }

  appendLiveToolOutput(sessionId: string, toolName: string, chunk: string): boolean {
    this.fireAndLog('appendLiveToolOutput', this.appendLiveToolOutputAsync(sessionId, toolName, chunk));
    return true;
  }

  async appendLiveToolOutputAsync(
    sessionId: string,
    toolName: string,
    chunk: string,
  ): Promise<boolean> {
    return this.mutateLiveToolStreamsInMemory(sessionId, (streams) => {
      const current = streams[toolName] ?? {
        name: toolName,
        chunks: [],
        status: 'running',
        lastUpdated: Date.now(),
      };
      const shouldForcePersist = current.chunks.length === 0;
      current.status = current.status === 'idle' ? 'running' : current.status;
      current.chunks = this.trimLiveToolChunks([...current.chunks, chunk]);
      current.lastUpdated = Date.now();
      streams[toolName] = current;
      return shouldForcePersist;
    });
  }

  recordLiveToolResult(sessionId: string, toolName: string, result: unknown): boolean {
    this.fireAndLog('recordLiveToolResult', this.recordLiveToolResultAsync(sessionId, toolName, result));
    return true;
  }

  recordTimelineEntry(sessionId: string, entry: TimelineEntry): boolean {
    this.fireAndLog('recordTimelineEntry', this.recordTimelineEntryAsync(sessionId, entry));
    return true;
  }

  async recordLiveToolResultAsync(
    sessionId: string,
    toolName: string,
    result: unknown,
  ): Promise<boolean> {
    return this.mutateLiveToolStreamsInMemory(sessionId, (streams) => {
      const current = streams[toolName] ?? {
        name: toolName,
        chunks: [],
        status: 'idle',
        lastUpdated: Date.now(),
      };
      const resultRecord = typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
      current.result = sanitizeLiveToolResult(toolName, result);
      current.status = resultRecord && 'error' in resultRecord ? 'error' : 'completed';
      current.lastUpdated = Date.now();
      streams[toolName] = current;
    }, { forcePersist: true });
  }

  async recordTimelineEntryAsync(
    sessionId: string,
    entry: TimelineEntry,
  ): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      session.timeline = this.upsertTimelineEntry(session.timeline ?? [], entry);
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }


  /**
   * Append multiple messages atomically as a batch.
   * 
   * This is critical for atomic turn persistence:
   * - Persists assistant message + all tool results together
   * - Prevents orphaned tool_calls (assistant with tool_calls but no results)
   * - Used by TurnRunner after tool execution completes
   * 
   * 
   * @param sessionId - Session to append messages to
   * @param messages - Array of messages to append atomically
   * @returns true if all messages were appended
   */
  async appendMessagesAsync(
    sessionId: string,
    messages: Message[],
  ): Promise<boolean> {
    if (messages.length === 0) {
      return true;
    }

    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      // Step 1: Add all messages to in-memory session (idempotent by ID)
      for (const message of messages) {
        // Skip duplicates - messages have unique IDs
        const exists = session.messages.some(m => m.id === message.id);
        if (!exists) {
          session.messages.push(message);
        }
      }

      // Journal-backed sessions already projected this batch atomically with
      // its semantic events. This queue remains only for legacy/no-journal hosts.
      if (!this.journalService) {
        for (const message of messages) this.queuePersistMessage(sessionId, message);
      }

      this.logger.debug(
        { sessionId, messageCount: messages.length },
        '[SessionStore] Batch appended messages',
      );

      return true;
    });
    return Boolean(updated);
  }

  private async mutateLiveToolStreamsInMemory(
    sessionId: string,
    mutator: (streams: Record<string, LiveToolStreamState>) => boolean | void,
    options: { forcePersist?: boolean } = {},
  ): Promise<boolean> {
    return this.cache.withLock(sessionId, async () => {
      const session = this.cache.get(sessionId);
      if (!session) {
        return false;
      }
      const streams = session.liveToolStreams ?? {};
      session.liveToolStreams = streams;
      const forcePersist = mutator(streams) === true || options.forcePersist === true;
      session.lastActive = Date.now();
      this.cache.set(sessionId, session);
      this.persistLiveToolStreamsSnapshot(session, forcePersist);
      return true;
    });
  }

  private persistLiveToolStreamsSnapshot(session: SessionState, force: boolean): void {
    const now = Date.now();
    const lastPersistAt = this.liveToolPersistAt.get(session.id) ?? 0;
    if (!force && now - lastPersistAt < LIVE_TOOL_PERSIST_DEBOUNCE_MS) {
      return;
    }
    this.liveToolPersistAt.set(session.id, now);
    this.queuePersistMetadata(session);
  }

  private trimLiveToolChunks(chunks: string[]): string[] {
    let total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    while (chunks.length > 1 && total > LIVE_TOOL_STREAM_MAX_CHARS) {
      const removed = chunks.shift();
      total -= removed?.length ?? 0;
    }
    if (chunks.length === 1 && total > LIVE_TOOL_STREAM_MAX_CHARS) {
      chunks[0] = chunks[0].slice(-LIVE_TOOL_STREAM_MAX_CHARS);
    }
    return chunks;
  }

  private upsertTimelineEntry(entries: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
    const next = [...entries];
    const replaceIndex =
      typeof entry.replaceKey === 'string' && entry.replaceKey.length > 0
        ? next.findIndex((candidate) => candidate.replaceKey === entry.replaceKey)
        : -1;
    const idIndex = replaceIndex === -1 ? next.findIndex((candidate) => candidate.id === entry.id) : -1;

    if (replaceIndex !== -1) {
      next[replaceIndex] = entry;
    } else if (idIndex !== -1) {
      next[idIndex] = entry;
    } else {
      next.push(entry);
    }

    next.sort((left, right) => left.ts - right.ts);
    return next.slice(Math.max(0, next.length - TIMELINE_MAX_ENTRIES));
  }

  /**
   * Update the current plan step ID.
   * Use this instead of setAsync for plan step transitions.
   * This ensures messages array stays intact during concurrent operations.
   */
  async updateCurrentPlanStepIdAsync(sessionId: string, stepId: string | undefined): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      session.currentPlanStepId = stepId;
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async addCheckpointAsync(sessionId: string, metadata: CheckpointMetadata): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      session.checkpoints[metadata.id] = metadata;
      session.lastCheckpoint = metadata;
      this.queuePersistCheckpoint(sessionId, metadata);
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async updateLastCheckpointAsync(
    sessionId: string,
    checkpointId: string,
  ): Promise<CheckpointMetadata | undefined> {
    return this.updateSessionAsync(sessionId, async (session) => {
      const checkpoint = session.checkpoints[checkpointId];
      if (!checkpoint) {
        return undefined;
      }
      session.lastCheckpoint = checkpoint;
      return checkpoint;
    });
  }

  async updatePlanAsync(sessionId: string, plan: PlanItem[]): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      await this.recordPlanChangedAsync(sessionId, plan);
      session.plan = plan;
      const recorder = this.traceRecorder;
      if (recorder) {
        const planPreview = plan
          .map((item) => `[${item.status}] ${item.title}`)
          .slice(0, 4)
          .join(' | ');
        recorder
          .write(sessionId, (session.turn ?? 0) + 1, {
            event: 'plan.snapshot',
            severity: 'info',
            payload: plan,
            note: summarizeForNote(planPreview || 'plan cleared'),
          })
          .catch((error) => {
            this.logger.warn({ err: error, sessionId }, 'Failed to record plan snapshot');
          });
      }
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async updatePlanStepAsync(sessionId: string, stepId: string, step: PlanItem): Promise<PlanItem[]> {
    const nextPlan = await this.updateSessionAsync(sessionId, async (session) => {
      const index = session.plan.findIndex((item) => item.id === stepId);
      if (index === -1) {
        return session.plan;
      }
      const updatedPlan = [...session.plan];
      updatedPlan[index] = step;
      await this.recordPlanChangedAsync(sessionId, updatedPlan);
      session.plan = updatedPlan;
      this.queuePersistMetadata(session);
      return updatedPlan;
    });
    return nextPlan ?? [];
  }

  async startTurnAsync(
    sessionId: string,
    controller: AbortController,
    metadata?: { reason?: string },
  ): Promise<boolean> {
    return this.turnManagementService.startTurn(sessionId, controller, metadata);
  }

  async clearCurrentTurnAsync(sessionId: string): Promise<void> {
    await this.turnManagementService.clearCurrentTurn(sessionId);
  }

  async abortCurrentTurnAsync(sessionId: string, reason?: string): Promise<void> {
    await this.turnManagementService.abortCurrentTurn(sessionId, reason);
  }

  async abortCurrentTurnAndWaitAsync(
    sessionId: string,
    reason?: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.turnManagementService.abortCurrentTurnAndWait(sessionId, reason, timeoutMs);
  }

  async waitForCurrentTurnToSettleAsync(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.turnManagementService.waitForCurrentTurnToSettle(sessionId, timeoutMs);
  }

  async updateStatusAsync(sessionId: string, status: SessionState['status']): Promise<SessionState | undefined> {
    return this.updateSessionAsync(sessionId, async (session) => {
      session.status = status;
      return session;
    });
  }

  async markAbortEventEmittedAsync(sessionId: string, reason?: string): Promise<void> {
    await this.turnManagementService.markAbortEventEmitted(sessionId, reason);
  }

  async setFlagAsync(sessionId: string, flagPath: string, value: unknown): Promise<boolean> {
    const [namespace, key] = parseFlagPath(flagPath);
    if (!namespace || !key) {
      return false;
    }
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      const nextFlags: SessionFlags = { ...session.flags };
      const namespaceState: Record<string, unknown> = {
        ...(nextFlags[namespace] as Record<string, unknown> | undefined),
      };

      if (typeof value === 'undefined') {
        delete namespaceState[key];
      } else {
        namespaceState[key] = value;
      }

      if (Object.keys(namespaceState).length === 0) {
        delete nextFlags[namespace];
      } else {
        nextFlags[namespace] = namespaceState;
      }

      session.flags = nextFlags;
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async mergeFlagNamespaceAsync(
    sessionId: string,
    namespace: string,
    values: Record<string, unknown>
  ): Promise<boolean> {
    if (!namespace || !values || typeof values !== 'object') {
      return false;
    }
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      const nextFlags: SessionFlags = { ...session.flags };
      const namespaceState: Record<string, unknown> = {
        ...(nextFlags[namespace] as Record<string, unknown> | undefined),
      };

      for (const [key, val] of Object.entries(values)) {
        if (typeof val === 'undefined') {
          delete namespaceState[key];
        } else {
          namespaceState[key] = val;
        }
      }

      if (Object.keys(namespaceState).length === 0) {
        delete nextFlags[namespace];
      } else {
        nextFlags[namespace] = namespaceState;
      }

      session.flags = nextFlags;
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async clearFlagsAsync(sessionId: string): Promise<boolean> {
    const updated = await this.updateSessionAsync(sessionId, async (session) => {
      if (Object.keys(session.flags).length === 0) {
        return true;
      }
      session.flags = {};
      this.queuePersistMetadata(session);
      return true;
    });
    return Boolean(updated);
  }

  async removeAsync(sessionId: string, reason: 'explicit' | 'ttl' = 'explicit'): Promise<boolean> {
    const settled = await this.abortCurrentTurnAndWaitAsync(
      sessionId,
      reason === 'explicit' ? 'session_removed' : 'session_ttl_evicted',
    );
    if (!settled) {
      throw new Error(`session_turn_did_not_settle:${sessionId}`);
    }
    return this.withSessionLock(sessionId, async () => this.removeInternal(sessionId, reason));
  }

  // Cleanup now delegated to SessionCleanupService

  shutdown(): void {
    this.lifecycleService.stopLocal();
    this.liveToolPersistAt.clear();
  }

  private async triggerSessionRemove(session: SessionState, reason: 'explicit' | 'ttl'): Promise<void> {
    if (!this.onSessionRemove) {
      return;
    }

    try {
      await Promise.resolve(this.onSessionRemove(session, reason));
    } catch (error) {
      this.logger.warn({ err: error, sessionId: session.id }, 'SessionStore onSessionRemove handler failed');
      // Resource teardown is part of removal correctness. Keeping the session
      // registered allows a later cleanup attempt and prevents callers from
      // recording a leaked sandbox as successfully removed.
      throw error;
    }
  }
}
