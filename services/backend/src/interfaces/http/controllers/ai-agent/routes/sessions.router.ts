import * as path from 'path';
import { Router } from 'express';
import { asyncHandler, idempotency, validate } from '../middleware';
import {
  sessionMessageBodySchema,
  sessionStopBodySchema,
} from '../schemas';
import type { AgentApiServices } from '../types';
import type { AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { SessionSummaryService } from '@/domains/agent-brain/application/services/SessionSummaryService';
import {
  assertRunObservabilityAccess,
  ensureSessionAccess,
  ensureSessionExists,
} from './helpers/sessionAccess';
import { createAgentRepositories, type AgentRepositories } from '@/app/services/agent/agentRepositories';
import type { SessionArtifact, SessionState } from '@/domains/agent-brain/domain/types';
import {
  SessionResponseBuilder, 
  type SessionUsageDTO as ResponseBuilderSessionUsageDTO,
} from '../services/SessionResponseBuilder';
import {
  type SessionControllerContext,
  SessionCrudController,
  SessionMessagingController,
  SessionCheckpointController,
  SessionArtifactController,
} from '../controllers';
import { logger as appLogger } from '@/shared/logger';
import { z } from 'zod';
import { createSubscriptionPort, createModelConfigPort } from '@/app/adapters/portFactories';
import { ErrorFactory, toAppError, sendApiError, ERROR_CODES } from '@/shared/errors';
import type { SubscriptionPort, ModelConfigPort } from '@/domains/agent-brain/ports';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import { db } from '@/db/client';
import { runs, scopes as scopesTable, organizations } from '@/db/schema';
import { eq, or } from 'drizzle-orm';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { ScopeAwareChatContextService } from '@/domains/security-ops/chat/ScopeAwareChatContextService';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '@/domains/agent-brain/application/orchestration/utils/sessionStatusEvents';
import {
  WorkerStartStopPolicy,
} from '@/domains/agent-brain/application/services/WorkerStartStopPolicy';
import { writeWorkbenchActionTrace } from './helpers/workbenchLifecycle';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PDF_REPORT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PDF_REPORT_IMAGE_MIME_TYPES = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeArtifactReportPath = (artifact: SessionArtifact): string =>
  (artifact.originalName || artifact.filePath || '').replace(/\\/g, '/');

const getPdfReportImageMimeType = (artifact: SessionArtifact): string | undefined => {
  const name = normalizeArtifactReportPath(artifact).toLowerCase();
  const extension = path.extname(name);
  return PDF_REPORT_IMAGE_MIME_TYPES.get(extension);
};

const isPdfReportImageArtifact = (artifact: SessionArtifact): boolean => {
  const name = normalizeArtifactReportPath(artifact).toLowerCase();
  return (
    name.startsWith('.artifacts/browser/screenshots/') ||
    name.includes('/.artifacts/browser/screenshots/')
  ) && Boolean(getPdfReportImageMimeType(artifact));
};

type SessionsRouterOptions = {
  appRole?: string;
  enableWorkers?: boolean;
};

type PdfReportRunCoverRow = {
  runTitle: string | null;
  runGoal: string | null;
  scopeName: string | null;
  orgName: string | null;
};

const truncatePdfSubtitle = (value: string | null | undefined): string | undefined => {
  if (!value || value.length === 0) return undefined;
  return value.length > 80 ? `${value.substring(0, 77)}...` : value;
};

const getStringProp = (record: Record<string, unknown> | undefined, key: string): string | undefined => {
  if (!record) return undefined;
  const prop = record[key];
  return typeof prop === 'string' ? prop : undefined;
};

const getSessionStringProp = (session: SessionState | undefined, key: string): string | undefined => {
  if (!session) {
    return undefined;
  }
  const record = session as unknown as Record<string, unknown>;
  return getStringProp(record, key);
};

export const resolvePdfReportCoverMetadata = (params: {
  session?: SessionState;
  dbSession?: { title?: string | null; createdAt?: Date | string | number | null } | null;
  runRow?: PdfReportRunCoverRow;
}): {
  title: string;
  taskName?: string;
  clientOrgName?: string;
  createdAt: Date;
} => {
  const runSubtitle = params.runRow?.scopeName ?? truncatePdfSubtitle(params.runRow?.runGoal);
  const sessionTaskName =
    getSessionStringProp(params.session, 'taskName') ?? params.session?.profileKey ?? undefined;
  const title =
    params.runRow?.runTitle
    ?? params.session?.title
    ?? params.dbSession?.title
    ?? params.runRow?.scopeName
    ?? truncatePdfSubtitle(params.runRow?.runGoal)
    ?? 'Security Assessment';

  return {
    title,
    taskName: params.runRow ? runSubtitle : sessionTaskName,
    clientOrgName: params.runRow?.orgName ?? undefined,
    createdAt: params.dbSession?.createdAt ? new Date(params.dbSession.createdAt) : new Date(),
  };
};

export type SessionsRouterDeps = AgentApiServices & {
  // Repository dependencies for testability
  repositories?: AgentRepositories;
  sessionRepository?: AgentRepositories['sessionRepository'];
  messageRepository?: AgentRepositories['messageRepository'];
  artifactRepository?: AgentRepositories['artifactRepository'];
  policyRepository?: AgentRepositories['policyRepository'];
  scopeAwareChatContextService?: ScopeAwareChatContextService;
  accessControl?: PlatformKernel['accessControl'];
  subscriptionPort?: SubscriptionPort;
  modelConfigPort?: ModelConfigPort;
  kernel?: PlatformKernel;
};

export const sessionsRouter = (services: SessionsRouterDeps, options: SessionsRouterOptions = {}): Router => {
  const router = Router();
  const kernel = services.kernel ?? createPlatformKernel();
  const organizationService = new OrganizationService(db);
  const repositories = services.repositories ?? createAgentRepositories();
  const sessionRepository = services.sessionRepository ?? repositories.sessionRepository;
  const accessControl = services.accessControl ?? kernel.accessControl;
  const subscriptionPort = services.subscriptionPort ?? createSubscriptionPort(accessControl);
  const modelConfigPort = services.modelConfigPort ?? createModelConfigPort();
  const scopeAwareChatContextService = services.scopeAwareChatContextService ?? new ScopeAwareChatContextService(
    db,
    organizationService,
    new ScopeService(db),
    accessControl,
  );
  const sessionService = new SessionService(
    services.sessionStore,
    services.sandboxProfileRegistry,
    services.ports,
    services.agentEngine,
    subscriptionPort,
    services.policyResolver,
    modelConfigPort,
    services.traceRecorder,
    services.sessionRepository ?? sessionRepository,
    services.policyFacade,
  );
  const sessionSummaryService = new SessionSummaryService(services.artifactService);
  const messageRepository = services.messageRepository ?? repositories.messageRepository;
  const artifactRepository = services.artifactRepository ?? repositories.artifactRepository;
  const artifactStorageRoot =
    services.artifactService?.getStorageRoot?.() ?? path.resolve(process.cwd(), 'storage', 'artifacts');
  const s3Artifacts = services.s3ArtifactsClient;

  // SessionResponseBuilder handles DTO transformations and caching
  const responseBuilder = new SessionResponseBuilder({
    s3Artifacts,
    artifactStorageRoot,
  });

  const log = appLogger.child({ scope: 'ai-agent:sessions' });
  const workerStartStopPolicy = new WorkerStartStopPolicy({
    sessionStore: services.sessionStore,
    sessionRepository,
    events: services.ports.events,
    traceRecorder: services.traceRecorder,
    log,
  });
  // Create shared controller context
  const controllerContext: SessionControllerContext = {
    services,
    sessionRepository,
    messageRepository,
    artifactRepository,
    sessionService,
    sessionSummaryService,
    scopeAwareChatContextService,
    accessControl,
    responseBuilder,
    artifactStorageRoot,
    s3Artifacts,
    log,
    options,
  };

  // Instantiate controllers
  const crudController = new SessionCrudController(controllerContext);
  const messagingController = new SessionMessagingController(controllerContext);
  const checkpointController = new SessionCheckpointController(controllerContext);
  const artifactController = new SessionArtifactController(controllerContext);

  // Delegate usage resolution to responseBuilder
  const resolveUsage = (session: SessionState | null): ResponseBuilderSessionUsageDTO | null =>
    responseBuilder.resolveUsage(session);

  const messagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    cursor: z.string().optional(),
    direction: z.enum(['forward', 'backward']).optional(),
  });
  const artifactParamsSchema = z.object({
    sessionId: z.string().min(1),
    artifactId: z.string().min(1),
  });
  const sessionIdParamSchema = z.object({
    sessionId: z.string().min(1),
  });
  const checkpointIdParamSchema = sessionIdParamSchema.extend({
    checkpointId: z.string().min(1),
  });

  const resolveSessionOwner = async (
    sessionId: string,
    req: AuthenticatedRequest,
  ): Promise<{ session?: SessionState }> => {
    const session = services.sessionStore.get(sessionId);
    if (session) {
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, req);
      return { session };
    }

    const row = await sessionRepository.findById(sessionId);
    if (!row) {
      throw ErrorFactory.session.notFound(sessionId);
    }
    const requester = req.user?.id;
    if (row.userId && requester && row.userId !== requester) {
      throw ErrorFactory.auth.insufficientPermissions('session', { context: { sessionId, userId: requester } });
    }
    return { session: undefined };
  };

  /**
   * GET /models - List model categories available for selection.
   * Concrete model names stay server-side; session creation resolves a
   * category to an active model at start time.
   */
  router.get(
    '/models',
    asyncHandler(async (_req, res) => {
      res.status(200).json({ models: await kernel.models.listAvailableCategories() });
    }),
  );

  /**
   * GET /catalog/tools - List tool manifests available to the agent runtime
   */
  router.get(
    '/catalog/tools',
    asyncHandler(async (_req, res) => {
      const manifests = await services.toolsRegistry.listManifests();
      res.status(200).json({
        tools: manifests.map((manifest) => ({
          id: manifest.id,
          summary: manifest.summary,
          argsSchema: manifest.argsSchema,
          meta: manifest.meta,
        })),
      });
    }),
  );

  router.get(
    '/sessions',
    asyncHandler(async (req, res) => crudController.listSessions(req, res)),
  );

  // GET /sessions/:sessionId/topology - Get lightweight session coordination topology
  router.get(
    '/sessions/:sessionId/topology',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => crudController.getSessionTopology(req, res)),
  );

  // GET /sessions/:sessionId - Get session details
  router.get(
    '/sessions/:sessionId',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => crudController.getSession(req, res)),
  );

  // Single-entrypoint model: product session creation must go through POST /api/app/runs.
  router.post(
    '/sessions',
    asyncHandler(async (_req, res) => {
      sendApiError(res, {
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Direct session creation is disabled. Use POST /api/app/runs with { scopeId, goal }.',
        status: 410,
      });
    }),
  );

  router.get(
    '/sessions/:sessionId/plan',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => crudController.getPlan(req, res)),
  );

  router.get(
    '/sessions/:sessionId/messages',
    validate({ params: sessionIdParamSchema, query: messagesQuerySchema }),
    asyncHandler(async (req, res) => crudController.getMessages(req, res)),
  );

  router.get(
    '/sessions/:sessionId/summary',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => messagingController.getSummary(req, res)),
  );

  /**
   * GET /sessions/:sessionId/usage
   * Returns current token usage for the session including limits and thresholds.
   * Useful for displaying usage meters and warning states in the UI.
   */
  router.get(
    '/sessions/:sessionId/usage',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => messagingController.getUsage(req, res)),
  );

  router.post(
    '/sessions/:sessionId/message',
    validate({ params: sessionIdParamSchema, body: sessionMessageBodySchema }),
    idempotency(),
    asyncHandler(async (req, res) => messagingController.sendMessage(req, res)),
  );

  router.get(
    '/sessions/:sessionId/checkpoints',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => checkpointController.listCheckpoints(req, res)),
  );

  router.post(
    '/sessions/:sessionId/checkpoints',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => checkpointController.createCheckpoint(req, res)),
  );

  router.post(
    '/sessions/:sessionId/checkpoints/:checkpointId/restore',
    validate({ params: checkpointIdParamSchema }),
    asyncHandler(async (req, res) => checkpointController.restoreCheckpoint(req, res)),
  );

  router.delete(
    '/sessions/:sessionId',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => crudController.deleteSession(req, res)),
  );

  // Schema for session update (rename)
  const sessionUpdateBodySchema = z.object({
    title: z.string().min(1).max(255),
  });

  /**
   * PATCH /sessions/:sessionId
   * Update session properties (currently: title/rename)
   */
  router.patch(
    '/sessions/:sessionId',
    validate({ params: sessionIdParamSchema, body: sessionUpdateBodySchema }),
    asyncHandler(async (req, res) => crudController.updateSession(req, res)),
  );

  router.get(
    '/sessions/:sessionId/artifacts',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => artifactController.listArtifacts(req, res)),
  );

  router.get(
    '/sessions/:sessionId/artifacts/:artifactId/download',
    validate({ params: artifactParamsSchema }),
    asyncHandler(async (req, res) => artifactController.downloadArtifact(req, res)),
  );

  router.get(
    '/sessions/:sessionId/artifacts/:artifactId/content',
    validate({ params: artifactParamsSchema }),
    asyncHandler(async (req, res) => artifactController.getArtifactContent(req, res)),
  );

  // ==========================================================================
  // PDF Report Download
  // ==========================================================================

  /**
   * GET /sessions/:sessionId/report/pdf
   * Generate and download a branded PDF report from the session's report.md artifact.
   * 
   * Rate limited: This endpoint is CPU-intensive.
   */
  router.get(
    '/sessions/:sessionId/report/pdf',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => {
      const { sessionId } = req.params;
      const authedReq = req as AuthenticatedRequest;
      const { session, artifacts } = await artifactController.resolveArtifactsForSession(
        sessionId,
        authedReq,
      );
      const reportArtifact = artifacts.find((item) => item.originalName?.toLowerCase() === 'report.md');
      if (!reportArtifact) {
        throw ErrorFactory.resource.notFound('report', sessionId, { 
          context: { sessionId, message: 'No report.md artifact found for this session' } 
        });
      }

      // Read report content
      const { content: markdown } = await responseBuilder.readArtifactContent(sessionId, reportArtifact);
      if (!markdown) {
        throw ErrorFactory.resource.notFound('report content', sessionId, {
          context: { sessionId, message: 'Report content is empty' }
        });
      }

      // Import PDF service dynamically to avoid loading Puppeteer on every request
      const { getPdfReportService } = await import('@/shared/pdf');
      const pdfService = getPdfReportService();

      // Get session metadata for the cover page
      const dbSession = await sessionRepository.findById(sessionId);

      // Resolve the run + scope + client org behind this session for the cover.
      // Sessions can be linked as the primary run session, the planner session, or the executor session.
      let runRow:
        | {
            runTitle: string | null;
            runGoal: string | null;
            scopeName: string | null;
            orgName: string | null;
          }
        | undefined;

      if (UUID_RE.test(sessionId)) {
        [runRow] = await db
          .select({
            runTitle: runs.title,
            runGoal: runs.goal,
            scopeName: scopesTable.name,
            orgName: organizations.name,
          })
          .from(runs)
          .leftJoin(scopesTable, eq(scopesTable.id, runs.scopeId))
          .leftJoin(organizations, eq(organizations.id, runs.organizationId))
          .where(
            or(
              eq(runs.sessionId, sessionId),
              eq(runs.plannerSessionId, sessionId),
              eq(runs.executorSessionId, sessionId),
            ),
          )
          .limit(1);
      }

      const { title, taskName, clientOrgName, createdAt } = resolvePdfReportCoverMetadata({
        session,
        dbSession,
        runRow,
      });
      const imageAssets: Array<{ sourcePaths: string[]; dataUrl: string }> = [];
      for (const artifact of artifacts.filter(isPdfReportImageArtifact)) {
        const mimeType = getPdfReportImageMimeType(artifact);
        if (!mimeType) {
          continue;
        }
        if (typeof artifact.sizeBytes === 'number' && artifact.sizeBytes > PDF_REPORT_IMAGE_MAX_BYTES) {
          log.warn(
            { sessionId, artifactId: artifact.id, sizeBytes: artifact.sizeBytes },
            'Skipping oversized report PDF image artifact',
          );
          continue;
        }

        try {
          const buffer = await artifactController.readArtifactBuffer(artifact, session);
          if (buffer.length > PDF_REPORT_IMAGE_MAX_BYTES) {
            log.warn(
              { sessionId, artifactId: artifact.id, sizeBytes: buffer.length },
              'Skipping oversized report PDF image artifact',
            );
            continue;
          }

          imageAssets.push({
            sourcePaths: [
              artifact.id ? `artifact:${artifact.id}` : '',
              artifact.originalName,
              artifact.filePath,
              normalizeArtifactReportPath(artifact).replace(/^sessions\/[^/]+\//, ''),
            ].filter((value): value is string => Boolean(value)),
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
          });
        } catch (error) {
          log.warn(
            { err: toAppError(error), sessionId, artifactId: artifact.id },
            'Failed to inline report PDF image artifact',
          );
        }
      }

      // Generate PDF
      const pdfBuffer = await pdfService.generateReport({
        markdown,
        sessionId,
        title,
        taskName,
        createdAt,
        userId: session?.userId,
        clientOrgName,
        classification: 'CONFIDENTIAL',
        imageAssets,
      });

      // Set response headers for PDF download
      const safeTitle = title.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="report-${safeTitle}-${sessionId.substring(0, 8)}.pdf"`);
      res.setHeader('Content-Length', pdfBuffer.length);
      
      res.send(pdfBuffer);
    }),
  );

  /**
   * POST /sessions/:sessionId/start
   * Append durable Start intent and schedule continuation.
   */
  router.post(
    '/sessions/:sessionId/start',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => {
      const { sessionId } = req.params;
      const authedReq = req as AuthenticatedRequest;

      const { session } = await resolveSessionOwner(sessionId, authedReq);
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, authedReq);
      await assertRunObservabilityAccess({
        session,
        req: authedReq,
        accessControl,
      });

      // Check durable blocked reason first, then fall back to in-memory state for
      // races where the turn was stopped locally before persistence completed.
      const durableBlockedReason = await sessionRepository.getBlockedReason(sessionId);
      const effectiveBlockedReason = durableBlockedReason ?? session.blockedReason ?? null;
      const currentState = responseBuilder.deriveSessionState(
        session,
        effectiveBlockedReason,
        session.completed === true
          || (isRecord(session.flags?.session) && session.flags.session.completed === true),
        false,
      );
      const journalProjection = await services.sessionStore.getJournalProjection?.(sessionId);

      if (
        currentState.status === 'running'
        && !effectiveBlockedReason
        && journalProjection?.desiredExecution !== 'stopped'
      ) {
        const executionReadModel = await services.sessionStore.getExecutionReadModel(sessionId);
        return res.status(200).json({
          success: true,
          started: true,
          blocked_reason: null,
          status: 'running',
          pause_reason: null,
          interaction_type: 'none',
          version: session.version ?? 0,
          ...executionReadModel,
          message: 'Session is already running.',
        });
      }

      const blockedReason = effectiveBlockedReason
        ?? (currentState.status === 'completed' ? 'completed' : currentState.status);

      const userId = session.userId ?? authedReq.user?.id;
      if (!userId) {
        throw ErrorFactory.auth.invalidSession({ httpStatus: 401, context: { sessionId } });
      }

      const startProjected = await services.sessionStore.recordStartRequestedAsync?.(
        sessionId,
        `start after ${blockedReason}`,
        authedReq.user?.id,
      ) ?? false;
      const scheduled = startProjected
        ? true
        : durableBlockedReason
          ? await sessionRepository.clearBlockedReason(sessionId, durableBlockedReason)
          : true;
      if (!scheduled) {
        const currentReason = await sessionRepository.getBlockedReason(sessionId).catch(() => null);
        throw ErrorFactory.session.invalidState(sessionId, currentReason ?? 'changed', blockedReason, {
          httpStatus: 409,
          userMessage: 'The session state changed while starting. Refresh and try again.',
          context: { sessionId, blockedReason, currentReason },
        });
      }
      const startedChildSessionIds = (
        blockedReason === 'user_paused'
        || blockedReason === 'credits_exhausted'
        || blockedReason === 'runner_unavailable'
      )
        ? await workerStartStopPolicy.startChildWorkers(sessionId, blockedReason)
        : [];

      await writeWorkbenchActionTrace({
        traceRecorder: services.traceRecorder,
        session,
        sessionId,
        action: 'start',
        operatorId: authedReq.user?.id ?? null,
        targetSessionId: sessionId,
        reason: blockedReason,
        result: 'accepted',
      });

      const executionReadModel = await services.sessionStore.getExecutionReadModel(sessionId);

      return res.status(200).json({
        success: true,
        started: true,
        recovery_scheduled: true,
        blocked_reason: null,
        status: 'running',
        pause_reason: null,
        interaction_type: 'none',
        version: session.version ?? 0,
        ...executionReadModel,
        child_recoveries_scheduled: startedChildSessionIds.length,
        usage: resolveUsage(session),
        message: 'Start accepted. Durable continuation is scheduled.',
      });
    }),
  );

  /**
   * POST /sessions/:sessionId/stop
   * Record durable Stop intent and interrupt current execution without deleting history.
   */
  router.post(
    '/sessions/:sessionId/stop',
    validate({ params: sessionIdParamSchema, body: sessionStopBodySchema }),
    asyncHandler(async (req, res) => {
      const { sessionId } = req.params;
      const authedReq = req as AuthenticatedRequest;

      const { session } = await resolveSessionOwner(sessionId, authedReq);
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, authedReq);
      await assertRunObservabilityAccess({
        session,
        req: authedReq,
        accessControl,
      });

      const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      const reason = rawReason || 'Stopped by operator.';
      const stopProjected = await services.sessionStore.recordStopRequestedAsync?.(
        sessionId,
        reason,
        authedReq.user?.id,
      ) ?? false;

      const previousStatus = deriveSessionStatusForEvent(session);
      const stoppedAt = new Date().toISOString();
      if (!stopProjected) {
        await sessionRepository.setBlockedReason(sessionId, 'user_paused', {
          stoppedAt,
          stoppedBy: authedReq.user?.id,
          reason,
        });
      }
      if (session.stateMachine?.isProcessing() ?? false) {
        session.stateMachine?.stopProcessing('user_paused', session.turn ?? 0, 'sessions.router.stop');
      }
      // Abort coordination is independent of the presentation state machine.
      // A lease-owned approval tool may be active while that projection is idle.
      await services.sessionStore.abortCurrentTurnAsync(sessionId, reason);
      session.blockedReason = 'user_paused';
      session.blockedMeta = {
        stoppedAt,
        stoppedBy: authedReq.user?.id,
        reason,
      };
      await services.sessionStore.setAsync(sessionId, session, 'user.stopped');
      await workerStartStopPolicy.blockChildWorkers(sessionId, 'user_paused', {
        stoppedAt,
        stoppedBy: authedReq.user?.id,
        reason,
      });
      const updatedSession = services.sessionStore.get(sessionId) ?? session;
      const stoppedState = responseBuilder.deriveSessionState(updatedSession, 'user_paused', false, false);
      emitSessionStatusEvent(
        services.ports.events,
        updatedSession,
        previousStatus,
        'user_paused',
        services.traceRecorder,
      );
      await writeWorkbenchActionTrace({
        traceRecorder: services.traceRecorder,
        session: updatedSession,
        sessionId,
        action: 'stop',
        operatorId: authedReq.user?.id ?? null,
        targetSessionId: sessionId,
        reason,
        result: 'accepted',
        extra: { source: 'stop' },
      });

      log.info({ sessionId }, '[Stop] Session stopped by user');

      const executionReadModel = await services.sessionStore.getExecutionReadModel(sessionId);

      return res.status(200).json({
        success: true,
        stopped: true,
        blocked_reason: 'user_paused',
        status: stoppedState.status,
        pause_reason: stoppedState.pauseReason,
        interaction_type: stoppedState.interactionType,
        version: updatedSession.version ?? 0,
        ...executionReadModel,
        message: 'Session stopped. Use Start to continue.',
      });
    }),
  );


  return router;
};



