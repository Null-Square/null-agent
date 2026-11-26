/**
 * SessionCrudController - Handle session CRUD operations
 * 
 * Routes:
 * - GET /sessions - List sessions
 * - GET /sessions/:sessionId - Get session details
 * - POST /sessions - Create session
 * - DELETE /sessions/:sessionId - Delete session
 * - PATCH /sessions/:sessionId - Update session (title)
 */

import { type Request, type Response } from 'express';
import { z } from 'zod';
import type { ModelCategory } from '@null-ai/contracts';
import {
  BaseSessionController,
  type SessionControllerContext,
  type AuthenticatedRequest,
  type SessionArtifact,
  type SessionState,
} from './types';
import {
  assertRunObservabilityAccess,
  ensureSessionAccess,
  ensureSessionExists,
  resolveRunObservabilityContext,
} from '../routes/helpers/sessionAccess';
import { ErrorFactory, isAppError, toAppError, getErrorMessage, ERROR_CODES } from '@/shared/errors';
import type { SessionUsageDTO, UsageHistoryEntryDTO } from '@/shared/types/dtos';
import {
  SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
  type ScopeAwareChatContextMetadata,
} from '@/domains/security-ops/chat/ScopeAwareChatContextService';

// Query/param schemas
export const sessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

export const sessionIdParamSchema = z.object({
  sessionId: z.string().min(1),
});

export const sessionUpdateBodySchema = z.object({
  title: z.string().min(1).max(255),
});

// Helpers
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const getStringProp = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  if (!record) return undefined;
  const prop = record[key];
  return typeof prop === 'string' ? prop : undefined;
};

const getBlockedMeta = (metadata: unknown, liveSession?: SessionState): Record<string, unknown> | null => {
  if (isRecord(liveSession?.blockedMeta)) {
    return liveSession.blockedMeta;
  }
  const record = isRecord(metadata) ? metadata : undefined;
  return isRecord(record?.blockedMeta) ? record.blockedMeta as Record<string, unknown> : null;
};

const normalizeExecutionTarget = (value: unknown): 'cloud' | 'scope_runner' | undefined => {
  if (value === 'scope_runner') {
    return 'scope_runner';
  }
  if (value === 'cloud') {
    return 'cloud';
  }
  return undefined;
};

const getSecurityOpsRecord = (
  liveSession: SessionState | undefined,
  metadata: unknown,
): { liveSecurityOps?: Record<string, unknown>; metadataSecurityOps?: Record<string, unknown> } => {
  const liveSecurityOps = isRecord(liveSession?.flags?.securityops)
    ? (liveSession.flags.securityops as Record<string, unknown>)
    : undefined;
  const metadataRecord = isRecord(metadata) ? metadata : undefined;
  const metadataFlags = isRecord(metadataRecord?.flags)
    ? (metadataRecord.flags as Record<string, unknown>)
    : undefined;
  const metadataSecurityOps = isRecord(metadataFlags?.securityops)
    ? (metadataFlags.securityops as Record<string, unknown>)
    : undefined;

  return { liveSecurityOps, metadataSecurityOps };
};

const resolveExecutionMetadata = (
  liveSession: SessionState | undefined,
  metadata: unknown,
): {
  executionTarget?: 'cloud' | 'scope_runner';
  runnerId: string | null;
  runnerName: string | null;
} => {
  const { liveSecurityOps, metadataSecurityOps } = getSecurityOpsRecord(liveSession, metadata);
  const executionTarget =
    normalizeExecutionTarget(liveSecurityOps?.executionTarget) ??
    normalizeExecutionTarget(metadataSecurityOps?.executionTarget);
  const runnerId =
    getStringProp(liveSecurityOps, 'runnerId') ??
    getStringProp(metadataSecurityOps, 'runnerId') ??
    null;
  const runnerName =
    getStringProp(liveSecurityOps, 'runnerName') ??
    getStringProp(metadataSecurityOps, 'runnerName') ??
    null;

  return { executionTarget, runnerId, runnerName };
};

const resolveWorkerMetadata = (
  liveSession: SessionState | undefined,
  metadata: unknown,
): {
  coordination?: SessionState['coordination'];
  workerTasks?: SessionState['workerTasks'];
  workerResult?: SessionState['workerResult'];
} => {
  const metadataRecord = isRecord(metadata) ? metadata : undefined;
  const coordination = isRecord(liveSession?.coordination)
    ? (liveSession?.coordination as unknown as SessionState['coordination'])
    : isRecord(metadataRecord?.coordination)
      ? (metadataRecord?.coordination as unknown as SessionState['coordination'])
      : undefined;
  const workerTasks = Array.isArray(liveSession?.workerTasks)
    ? liveSession.workerTasks
    : Array.isArray(metadataRecord?.workerTasks)
      ? (metadataRecord?.workerTasks as unknown as SessionState['workerTasks'])
      : undefined;
  const workerResult = isRecord(liveSession?.workerResult)
    ? (liveSession.workerResult as unknown as SessionState['workerResult'])
    : isRecord(metadataRecord?.workerResult)
      ? (metadataRecord?.workerResult as unknown as SessionState['workerResult'])
      : undefined;
  return { coordination, workerTasks, workerResult };
};

const isReadOnlyAssistantSession = (
  liveSession: SessionState | undefined,
  metadata: unknown,
): boolean => {
  const { liveSecurityOps, metadataSecurityOps } = getSecurityOpsRecord(liveSession, metadata);

  const assistantMode =
    getStringProp(liveSecurityOps, 'assistantMode') ??
    getStringProp(metadataSecurityOps, 'assistantMode');

  return assistantMode === 'read_only_chat';
};

const artifactIdentity = (artifact: { id?: string; filePath: string; originalName?: string }): string => {
  const originalName = artifact.originalName?.trim().toLowerCase();
  if (originalName) {
    return `name:${originalName}`;
  }
  const filePath = artifact.filePath.trim().toLowerCase();
  if (filePath) {
    return `path:${filePath}`;
  }
  return `id:${artifact.id ?? ''}`;
};

export class SessionCrudController extends BaseSessionController {
  constructor(context: SessionControllerContext) {
    super(context);
  }

  private async canExposeRunObservability(params: {
    session?: SessionState;
    metadata?: unknown;
    req: AuthenticatedRequest;
  }): Promise<boolean> {
    if (!resolveRunObservabilityContext(params.session, params.metadata)) {
      return true;
    }

    try {
      await assertRunObservabilityAccess({
        session: params.session,
        metadata: params.metadata,
        req: params.req,
        accessControl: this.ctx.accessControl,
      });
      return true;
    } catch (error) {
      const appError = toAppError(error);
      if (
        appError.code === ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE &&
        (appError.context as { feature?: unknown } | undefined)?.feature === 'accessRunObservability'
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * GET /sessions - List sessions for authenticated user
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    const authedReq = req as AuthenticatedRequest;
    const userId = authedReq.user?.id;

    if (!userId) {
      throw ErrorFactory.auth.invalidApiKey();
    }

    const query = sessionsQuerySchema.safeParse(req.query);
    const limit = query.success ? query.data.limit ?? 50 : 50;
    const offset = query.success ? query.data.offset ?? 0 : 0;
    const statusFilter = query.success ? query.data.status : undefined;

    const rows = await this.sessionRepository.listByUser(userId, { limit: limit + 1, offset, status: statusFilter });
    const liveSessions = this.services.sessionStore.listByUser(userId);

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const mergedIds = Array.from(new Set([...rowById.keys(), ...liveById.keys()]));
    const executionReadModels = await this.services.sessionStore.getExecutionReadModels(mergedIds);

    const merged = mergedIds.flatMap((id) => {
      const row = rowById.get(id);
      const liveSession = liveById.get(id);
      if (isReadOnlyAssistantSession(liveSession, row?.metadata)) {
        return [];
      }
      const createdAtRaw = row?.createdAt ?? liveSession?.createdAt ?? Date.now();
      const createdAt = this.responseBuilder.toMillis(createdAtRaw, Date.now());
      const lastActiveRaw = liveSession?.lastActive ?? row?.lastActiveAt ?? createdAtRaw;
      const lastActive = this.responseBuilder.toMillis(lastActiveRaw, createdAt);
      const updatedAtRaw = row?.updatedAt ?? lastActiveRaw;
      const updatedAt = this.responseBuilder.toMillis(updatedAtRaw, lastActive);

      const metadata = row?.metadata;
      const execution = resolveExecutionMetadata(liveSession, metadata);
      const recentActivityState = this.responseBuilder.deriveRuntimeState({
        row: row ?? { lastActiveAt: new Date(lastActive) },
        metadata,
      });
      const isProcessing =
        (liveSession?.stateMachine?.isProcessing() ?? false) ||
        recentActivityState.isProcessing;
      const derivedState = this.responseBuilder.deriveRuntimeState({
        row: row ?? null,
        liveSession,
        metadata,
        isProcessing,
      });
      const title =
        liveSession?.title ??
        row?.title ??
        liveSession?.task?.title ??
        getStringProp(metadata, 'taskTitle') ??
        null;

      return [{
        id,
        ...executionReadModels.get(id),
        userId: row?.userId ?? liveSession?.userId ?? userId,
        title,
        status: derivedState.status,
        pause_reason: derivedState.pauseReason,
        interaction_type: derivedState.interactionType,
        blocked_reason: derivedState.blockedReason,
        blocked_meta: getBlockedMeta(metadata, liveSession),
        isProcessing: derivedState.isProcessing,
        completed: derivedState.completed,
        mode: row?.mode ?? liveSession?.mode ?? 'interactive',
        version: liveSession?.version ?? 0,
        createdAt,
        lastActive,
        updatedAt,
        summary: liveSession?.summary ?? row?.summary,
        task: liveSession?.task ? { id: liveSession.task.id, title: liveSession.task.title } : undefined,
        executionTarget: execution.executionTarget,
        runnerId: execution.runnerId,
        runnerName: execution.runnerName,
      }];
    });

    const sorted = merged.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    const sliced = sorted.slice(offset, offset + limit);
    const hasMore = rows.length > limit || sorted.length > offset + limit;

    res.status(200).json({
      sessions: sliced,
      total: undefined,
      hasMore,
    });
  }

  /**
   * GET /sessions/:sessionId - Get session details
   */
  async getSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;
    const userId = authedReq.user?.id;

    // First check in-memory session store
    const liveSession = this.services.sessionStore.get(sessionId);
    if (liveSession) {
      ensureSessionExists(liveSession, sessionId);
      ensureSessionAccess(liveSession, authedReq);

      const artifacts = await this.getArtifactsForSession(sessionId, liveSession);

      // Read report.md and summary.md content
      const { reportContent, summaryContent } = await this.readReportAndSummary(sessionId, artifacts);

      const persistedRow = await this.sessionRepository.findById(sessionId).catch(() => null);
      const dbBlockedReason =
        persistedRow?.blockedReason ??
        await this.sessionRepository.getBlockedReason?.(sessionId).catch(() => null) ??
        null;
      const dbCompleted =
        persistedRow?.completed ??
        await this.sessionRepository.getCompleted?.(sessionId).catch(() => false) ??
        false;
      const effectiveCompleted =
        dbCompleted ||
        liveSession.completed === true ||
        (liveSession.flags?.session as Record<string, unknown>)?.completed === true;
      const derivedState = this.responseBuilder.deriveRuntimeState({
        row: persistedRow ?? null,
        liveSession,
        metadata: persistedRow?.metadata ?? null,
        blockedReason: dbBlockedReason,
        completed: effectiveCompleted,
      });
      const visibleMessages = this.responseBuilder.filterVisibleMessages(liveSession.messages ?? []);
      const execution = resolveExecutionMetadata(liveSession, persistedRow?.metadata);
      const workerMetadata = resolveWorkerMetadata(liveSession, persistedRow?.metadata);
      const includeRunObservability = await this.canExposeRunObservability({
        session: liveSession,
        metadata: persistedRow?.metadata,
        req: authedReq,
      });
      const executionReadModel = await this.services.sessionStore.getExecutionReadModel(sessionId);

      res.status(200).json({
        session: {
          id: liveSession.id,
          ...executionReadModel,
          userId: liveSession.userId,
          title: liveSession.title ?? liveSession.task?.title ?? null,
          status: derivedState.status,
          pause_reason: derivedState.pauseReason,
          interaction_type: derivedState.interactionType,
          blocked_reason: derivedState.blockedReason ?? undefined,
          isProcessing: derivedState.isProcessing,
          pendingApproval: liveSession.pendingApproval ?? null,
          completed: derivedState.completed,
          mode: liveSession.mode,
          version: liveSession.version ?? 0,
          createdAt: liveSession.createdAt,
          lastActive: liveSession.lastActive,
          turn: liveSession.turn,
          summary: summaryContent ?? liveSession.summary,
          report: reportContent ?? null,
          messages: includeRunObservability
            ? visibleMessages.map((m) => this.responseBuilder.toMessageResponse(m))
            : [],
          plan: includeRunObservability ? liveSession.plan ?? [] : [],
          usage: this.responseBuilder.resolveUsage(liveSession),
          usageHistory: includeRunObservability ? this.responseBuilder.resolveUsageHistory(liveSession) : [],
          artifacts: [],
          liveToolStreams: includeRunObservability ? liveSession.liveToolStreams ?? {} : {},
          timeline: includeRunObservability ? liveSession.timeline ?? [] : [],
          task: liveSession.task ? { id: liveSession.task.id, title: liveSession.task.title } : undefined,
          executionTarget: execution.executionTarget,
          runnerId: execution.runnerId,
          runnerName: execution.runnerName,
          coordination: includeRunObservability ? workerMetadata.coordination : undefined,
          workerTasks: includeRunObservability ? workerMetadata.workerTasks ?? [] : [],
          workerResult: includeRunObservability ? workerMetadata.workerResult ?? null : null,
        },
      });
      return;
    }

    // Fall back to database
    const row = await this.sessionRepository.findById(sessionId);
    if (!row) {
      throw ErrorFactory.session.notFound(sessionId);
    }

    if (row.userId && userId && row.userId !== userId) {
      throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId } });
    }

    const artifacts = await this.getArtifactsForSession(sessionId);

    const { reportContent, summaryContent } = await this.readReportAndSummary(sessionId, artifacts);

    const page = await this.messageRepository.listBySessionPaged(sessionId, { limit: 500 });
    const messages = page.data;
    const metadata = row.metadata;
    const execution = resolveExecutionMetadata(undefined, metadata);
    const workerMetadata = resolveWorkerMetadata(undefined, metadata);
    const taskTitle = getStringProp(metadata, 'taskTitle');
    const usage = isRecord(metadata.usage) ? (metadata.usage as unknown as SessionUsageDTO) : null;
    const usageHistory = Array.isArray(metadata.usageHistory)
      ? (metadata.usageHistory as UsageHistoryEntryDTO[])
      : [];
    const liveToolStreams = isRecord(metadata.liveToolStreams)
      ? (metadata.liveToolStreams as Record<string, unknown>)
      : {};
    const timeline = Array.isArray(metadata.timeline)
      ? metadata.timeline
      : [];
    const derivedState = this.responseBuilder.deriveRuntimeState({
      row,
      metadata,
    });
    const visibleMessages = this.responseBuilder.filterVisibleMessages(messages);
    const includeRunObservability = await this.canExposeRunObservability({
      metadata,
      req: authedReq,
    });
    const executionReadModel = await this.services.sessionStore.getExecutionReadModel(sessionId);

    res.status(200).json({
      session: {
        id: row.id,
        ...executionReadModel,
        userId: row.userId,
        title: row.title ?? taskTitle ?? null,
        status: derivedState.status,
        pause_reason: derivedState.pauseReason,
        interaction_type: derivedState.interactionType,
        blocked_reason: derivedState.blockedReason ?? undefined,
        blocked_meta: getBlockedMeta(metadata),
        isProcessing: derivedState.isProcessing,
        pendingApproval: isRecord(metadata) && isRecord(metadata.pendingApproval) ? metadata.pendingApproval : null,
        version: 0,
        completed: derivedState.completed,
        mode: row.mode,
        createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
        lastActive: row.lastActiveAt instanceof Date ? row.lastActiveAt.getTime() : row.lastActiveAt,
        summary: summaryContent ?? row.summary,
        report: reportContent ?? null,
        messages: includeRunObservability
          ? visibleMessages.map((m) => this.responseBuilder.toMessageResponse(m))
          : [],
        plan: includeRunObservability ? row.plan ?? [] : [],
        artifacts: [],
        usage,
        usageHistory: includeRunObservability ? usageHistory : [],
        liveToolStreams: includeRunObservability ? liveToolStreams : {},
        timeline: includeRunObservability ? timeline : [],
        executionTarget: execution.executionTarget,
        runnerId: execution.runnerId,
        runnerName: execution.runnerName,
        coordination: includeRunObservability ? workerMetadata.coordination : undefined,
        workerTasks: includeRunObservability ? workerMetadata.workerTasks ?? [] : [],
        workerResult: includeRunObservability ? workerMetadata.workerResult ?? null : null,
      },
    });
  }

  /**
   * GET /sessions/:sessionId/topology - Get lightweight coordination/worker topology
   */
  async getSessionTopology(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;

    const liveSession = this.services.sessionStore.get(sessionId);
    if (liveSession) {
      ensureSessionExists(liveSession, sessionId);
      ensureSessionAccess(liveSession, authedReq);

      const persistedRow = await this.sessionRepository.findById(sessionId).catch(() => null);
      const dbBlockedReason =
        persistedRow?.blockedReason ??
        await this.sessionRepository.getBlockedReason?.(sessionId).catch(() => null) ??
        null;
      const dbCompleted =
        persistedRow?.completed ??
        await this.sessionRepository.getCompleted?.(sessionId).catch(() => false) ??
        false;
      const effectiveCompleted =
        dbCompleted ||
        liveSession.completed === true ||
        (liveSession.flags?.session as Record<string, unknown>)?.completed === true;
      const derivedState = this.responseBuilder.deriveRuntimeState({
        row: persistedRow ?? null,
        liveSession,
        metadata: persistedRow?.metadata ?? null,
        blockedReason: dbBlockedReason,
        completed: effectiveCompleted,
      });
      const execution = resolveExecutionMetadata(liveSession, persistedRow?.metadata);
      const workerMetadata = resolveWorkerMetadata(liveSession, persistedRow?.metadata);
      const executionReadModel = await this.services.sessionStore.getExecutionReadModel(sessionId);
      await assertRunObservabilityAccess({
        session: liveSession,
        metadata: persistedRow?.metadata,
        req: authedReq,
        accessControl: this.ctx.accessControl,
      });

      res.status(200).json({
        session: {
          id: liveSession.id,
          ...executionReadModel,
          title: liveSession.title ?? liveSession.task?.title ?? null,
          status: derivedState.status,
          pause_reason: derivedState.pauseReason,
          interaction_type: derivedState.interactionType,
          blocked_reason: derivedState.blockedReason ?? undefined,
          blocked_meta: getBlockedMeta(persistedRow?.metadata, liveSession),
          completed: derivedState.completed,
          executionTarget: execution.executionTarget,
          runnerId: execution.runnerId,
          runnerName: execution.runnerName,
          coordination: workerMetadata.coordination,
          workerTasks: workerMetadata.workerTasks ?? [],
          workerResult: workerMetadata.workerResult ?? null,
        },
      });
      return;
    }

    const row = await this.sessionRepository.findById(sessionId);
    if (!row) {
      throw ErrorFactory.session.notFound(sessionId);
    }

    const requester = authedReq.user?.id;
    if (row.userId && requester && row.userId !== requester) {
      throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId: requester } });
    }

    const metadata = row.metadata;
    await assertRunObservabilityAccess({
      metadata,
      req: authedReq,
      accessControl: this.ctx.accessControl,
    });
    const execution = resolveExecutionMetadata(undefined, metadata);
    const workerMetadata = resolveWorkerMetadata(undefined, metadata);
    const taskTitle = getStringProp(isRecord(metadata) ? metadata : undefined, 'taskTitle');
    const derivedState = this.responseBuilder.deriveRuntimeState({
      row,
      metadata,
    });
    const executionReadModel = await this.services.sessionStore.getExecutionReadModel(sessionId);

    res.status(200).json({
      session: {
        id: row.id,
        ...executionReadModel,
        title: row.title ?? taskTitle ?? null,
        status: derivedState.status,
        pause_reason: derivedState.pauseReason,
        interaction_type: derivedState.interactionType,
        blocked_reason: row.blockedReason ?? undefined,
        blocked_meta: getBlockedMeta(metadata),
        completed: row.completed ?? false,
        executionTarget: execution.executionTarget,
        runnerId: execution.runnerId,
        runnerName: execution.runnerName,
        coordination: workerMetadata.coordination,
        workerTasks: workerMetadata.workerTasks ?? [],
        workerResult: workerMetadata.workerResult ?? null,
      },
    });
  }

  /**
   * POST /sessions - Create new session
   */
  async createSession(req: Request, res: Response): Promise<void> {
    const authedReq = req as AuthenticatedRequest;
    const { modelId, modelCategory, profileKey, extraContext, scopeId, vars, mode } = req.body as {
      modelId?: string;
      modelCategory?: ModelCategory;
      profileKey?: string;
      extraContext?: string;
      scopeId?: string;
      vars?: Record<string, unknown>;
      mode?: 'interactive' | 'automated';
    };

    try {
      const workersEnabled = this.ctx.options.enableWorkers ?? true;
      const appRole = this.ctx.options.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        throw ErrorFactory.internal.configuration('session_creation_disabled_on_api_node', {
          httpStatus: 503,
          context: { appRole, workersEnabled },
        });
      }

      let resolvedExtraContext = extraContext;
      let resolvedScopeId = scopeId;
      let scopeContextMetadata: ScopeAwareChatContextMetadata | undefined;

      if (scopeId) {
        const userId = authedReq.user?.id;
        if (!userId) {
          throw ErrorFactory.auth.invalidApiKey();
        }

        const scopeAwareChatContextService = this.ctx.scopeAwareChatContextService;
        if (!scopeAwareChatContextService) {
          throw ErrorFactory.internal.configuration('scope_aware_chat_context_service_missing');
        }

        const scopeContext = await scopeAwareChatContextService.buildForUser({
          userId,
          scopeId,
          userExtraContext: extraContext,
        });

        resolvedExtraContext = scopeContext.renderedContext;
        resolvedScopeId = scopeContext.scopeId;
        scopeContextMetadata = scopeContext.metadata;
      }

      await this.ctx.accessControl.enforceSessionCreation({
        userId: authedReq.user?.id,
        organizationId: scopeContextMetadata?.organizationId,
        mode,
        sessionStore: this.services.sessionStore,
        sessionRepository: this.sessionRepository,
      });

      const sessionService = this.ctx.sessionService as {
        createSession(opts: {
          userId?: string;
          modelId?: string;
          modelCategory?: ModelCategory;
          profileKey?: string;
          extraContext?: string;
          scopeId?: string;
          vars?: Record<string, unknown>;
          mode?: 'interactive' | 'automated';
          organizationId?: string | null;
        }): Promise<{ session: { id: string }; preparation?: { sessionTask?: { id: string; title: string; category?: string; summary?: string; versionHash?: string }; redactedVars?: Record<string, unknown>; starterPrompt?: string } }>;
      };
      const { session, preparation } = await sessionService.createSession({
        userId: authedReq.user?.id,
        organizationId: scopeContextMetadata?.organizationId,
        modelId,
        modelCategory,
        profileKey,
        extraContext: resolvedExtraContext,
        scopeId: resolvedScopeId,
        vars,
        mode,
      });

      if (scopeContextMetadata) {
        await this.services.sessionStore.mergeFlagNamespaceAsync(session.id, 'securityops', {
          organizationId: scopeContextMetadata.organizationId,
          scopeId: scopeContextMetadata.scopeId,
          contextSchema: scopeContextMetadata.schema,
          contextSections: scopeContextMetadata.sections,
        });
      }

      res.status(201).json({
        sessionId: session.id,
        task: preparation?.sessionTask
          ? {
            id: preparation.sessionTask.id,
            title: preparation.sessionTask.title,
            category: preparation.sessionTask.category,
            summary: preparation.sessionTask.summary,
            versionHash: preparation.sessionTask.versionHash,
            vars: preparation.redactedVars,
          }
          : undefined,
        starterPrompt: preparation?.starterPrompt,
        scopeContext: scopeContextMetadata
          ? {
            organizationId: scopeContextMetadata.organizationId,
            scopeId: scopeContextMetadata.scopeId,
            schema: scopeContextMetadata.schema ?? SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
            sections: scopeContextMetadata.sections,
          }
          : undefined,
      });
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      const originalStatus = typeof (error as { status?: number })?.status === 'number'
        ? (error as { status: number }).status
        : undefined;
      const appErr = toAppError(error);
      const message = getErrorMessage(error) || 'Failed to create session';
      console.error('[AgentRouter] session.create_failed', appErr);
      throw ErrorFactory.internal.unexpected(message, { httpStatus: originalStatus ?? appErr.httpStatus });
    }
  }

  /**
   * DELETE /sessions/:sessionId - Delete session
   */
  async deleteSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    const session = this.services.sessionStore.get(sessionId);
    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);

    await this.services.agentEngine.cleanupSession(sessionId, session).catch((error) => {
      console.warn(`Failed to cleanup session ${sessionId}:`, error);
    });

    const removed = this.services.sessionStore.remove(sessionId, 'explicit');
    if (removed) {
      res.status(200).json({ message: 'Session deleted' });
    } else {
      throw ErrorFactory.session.notFound(sessionId);
    }
  }

  /**
   * PATCH /sessions/:sessionId - Update session (title)
   */
  async updateSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const { title } = req.body as { title: string };

    const authedReq = req as AuthenticatedRequest;
    const session = this.services.sessionStore.get(sessionId);
    
    if (!session) {
      const row = await this.sessionRepository.findById(sessionId);
      if (!row) {
        throw ErrorFactory.session.notFound(sessionId);
      }
      const requester = authedReq.user?.id;
      if (row.userId && requester && row.userId !== requester) {
        throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId: requester } });
      }
    } else {
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, authedReq);
    }

    const updated = await this.sessionRepository.updateTitle(sessionId, title);
    if (!updated) {
      throw ErrorFactory.session.notFound(sessionId);
    }

    if (session) {
      session.title = title;
      this.services.sessionStore.set(sessionId, session);
    }

    res.status(200).json({ success: true, title });
  }

  /**
   * GET /sessions/:sessionId/plan - Get session plan
   */
  async getPlan(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const session = this.services.sessionStore.get(sessionId);
    const authedReq = req as AuthenticatedRequest;
    ensureSessionExists(session, sessionId);
    ensureSessionAccess(session, authedReq);
    const persistedRow = await this.sessionRepository.findById(sessionId).catch(() => null);
    await assertRunObservabilityAccess({
      session,
      metadata: persistedRow?.metadata,
      req: authedReq,
      accessControl: this.ctx.accessControl,
    });
    res.status(200).json(session.plan ?? []);
  }

  /**
   * GET /sessions/:sessionId/messages - Get paginated messages
   */
  async getMessages(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const authedReq = req as AuthenticatedRequest;
    
    // Resolve session owner (validate access)
    const session = this.services.sessionStore.get(sessionId);
    let metadata: unknown | undefined;
    if (session) {
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, authedReq);
      const row = await this.sessionRepository.findById(sessionId).catch(() => null);
      metadata = row?.metadata;
    } else {
      const row = await this.sessionRepository.findById(sessionId);
      if (!row) {
        throw ErrorFactory.session.notFound(sessionId);
      }
      const requester = authedReq.user?.id;
      if (row.userId && requester && row.userId !== requester) {
        throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId: requester } });
      }
      metadata = row.metadata;
    }

    await assertRunObservabilityAccess({
      session,
      metadata,
      req: authedReq,
      accessControl: this.ctx.accessControl,
    });

    const { limit, cursor, direction } = req.query as {
      limit?: number;
      cursor?: string;
      direction?: 'forward' | 'backward';
    };

    const page = await this.messageRepository.listBySessionPaged(sessionId, {
      limit,
      cursor,
      direction,
    });

    const responseLimit = typeof limit === 'number' ? limit : undefined;

    res.status(200).json({
      messages: this.responseBuilder
        .filterVisibleMessages(page.data)
        .map((m) => this.responseBuilder.toMessageResponse(m)),
      pagination: {
        limit: responseLimit ?? 100,
        hasMore: page.meta.hasMore,
        cursor: page.meta.nextCursor,
      },
    });
  }

  private async getArtifactsForSession(
    sessionId: string,
    liveSession?: SessionState,
  ): Promise<Array<SessionArtifact & { sizeBytes?: number; createdAt?: number; storage?: 'local' | 's3'; bucket?: string }>> {
    const persistedArtifacts = (await this.ctx.artifactRepository.listBySession(sessionId))
      .map((row) => this.responseBuilder.adaptArtifactRow(row));
    const liveArtifacts = Array.isArray(liveSession?.artifacts)
      ? liveSession.artifacts.map((artifact) => this.responseBuilder.adaptArtifactRow(artifact))
      : [];

    if (liveArtifacts.length === 0) {
      return persistedArtifacts;
    }
    if (persistedArtifacts.length === 0) {
      return liveArtifacts;
    }

    const merged = new Map<string, SessionArtifact & { sizeBytes?: number; createdAt?: number; storage?: 'local' | 's3'; bucket?: string }>();
    for (const artifact of liveArtifacts) {
      merged.set(artifactIdentity(artifact), artifact);
    }
    for (const artifact of persistedArtifacts) {
      const key = artifactIdentity(artifact);
      if (!merged.has(key)) {
        merged.set(key, artifact);
      }
    }
    return Array.from(merged.values());
  }

  // Helper to read report.md and summary.md content
  private async readReportAndSummary(
    sessionId: string,
    artifacts: Array<{ id: string; filePath: string; originalName?: string; fileType?: string }>,
  ): Promise<{ reportContent?: string; summaryContent?: string }> {
    const reportArtifact = artifacts.find((a) => a.originalName?.toLowerCase() === 'report.md');
    const summaryArtifact = artifacts.find((a) => a.originalName?.toLowerCase() === 'summary.md');

    let reportContent: string | undefined;
    let summaryContent: string | undefined;

    if (reportArtifact) {
      const cacheKey = `${sessionId}:report.md`;
      const cached = this.responseBuilder.getCachedArtifactContent(cacheKey);
      if (cached) {
        reportContent = cached;
      } else {
        try {
          const { content } = await this.responseBuilder.readArtifactContent(sessionId, {
            id: reportArtifact.id,
            filePath: reportArtifact.filePath,
          });
          reportContent = content;
          this.responseBuilder.setCachedArtifactContent(cacheKey, content);
        } catch (err) {
          this.log.warn({ err, sessionId, artifactId: reportArtifact.id }, 'failed to read report.md');
        }
      }
    }

    if (summaryArtifact) {
      const cacheKey = `${sessionId}:summary.md`;
      const cached = this.responseBuilder.getCachedArtifactContent(cacheKey);
      if (cached) {
        summaryContent = cached;
      } else {
        try {
          const { content } = await this.responseBuilder.readArtifactContent(sessionId, {
            id: summaryArtifact.id,
            filePath: summaryArtifact.filePath,
          });
          summaryContent = content;
          this.responseBuilder.setCachedArtifactContent(cacheKey, content);
        } catch (err) {
          this.log.warn({ err, sessionId, artifactId: summaryArtifact.id }, 'failed to read summary.md');
        }
      }
    }

    return { reportContent, summaryContent };
  }
}

