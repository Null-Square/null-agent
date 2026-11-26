import { Router, type RequestHandler } from 'express';
import { validate } from '../middleware';
import {
  sessionStreamParamsSchema,
  sessionStreamQueryParamsSchema,
} from '../schemas';
import type { AgentApiServices } from '../types';
import type { AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import { assertRunObservabilityAccess, ensureSessionAccess, ensureSessionExists } from './helpers/sessionAccess';
import { AppError, toAppError } from '@/shared/errors';
import { SSE_KEEPALIVE_MS } from '@/config/timeouts';
import { ERROR_CODES } from '@null-ai/contracts';
import { deriveSessionEventState } from '@/domains/agent-brain/application/orchestration/utils/sessionStatusEvents';
import type { Message, SessionArtifact, SessionState } from '@/domains/agent-brain/domain/types';
import { redactProviderReasoningMetadata } from '@/domains/agent-brain/domain/reasoning/providerReasoning';
import { resolveRunnerSessionBinding } from '@/domains/security-ops/runners/runnerSession';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';

const TOKEN_USAGE_HISTORY_FLAG = 'token_usage_history';

type StreamRouterOptions = {
  accessControl?: PlatformKernel['accessControl'];
};

export const streamRouter = (services: AgentApiServices, options: StreamRouterOptions = {}): Router => {
  const router = Router();
  let resolvedAccessControl = options.accessControl;

  const getAccessControl = (): PlatformKernel['accessControl'] => {
    if (!resolvedAccessControl) {
      resolvedAccessControl = createPlatformKernel().accessControl;
    }
    return resolvedAccessControl;
  };

  const getBlockedReason = (session: SessionState): string | null =>
    session.blockedReason ??
    (typeof session.flags?.blocked_reason === 'string' ? session.flags.blocked_reason : null) ??
    null;

  const isVisibleMessage = (message: Message): boolean =>
    message.metadata?.visibility !== 'internal';

  const toMessageResponse = (message: Message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    metadata: redactProviderReasoningMetadata(message.metadata),
    status: message.status ?? (typeof message.metadata?.status === 'string' ? message.metadata.status : undefined),
    timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
  });

  const toArtifactResponse = (artifact: SessionArtifact) => ({
    id: artifact.id,
    filePath: artifact.filePath,
    originalName: artifact.originalName,
    fileType: artifact.fileType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    storage: artifact.storage,
    bucket: artifact.bucket,
  });

  const toUsageResponse = (session: SessionState) => {
    const usage = session.usage;
    if (!usage) {
      return null;
    }
    const promptTokens = typeof usage.promptTokens === 'number' ? usage.promptTokens : 0;
    const completionTokens = typeof usage.completionTokens === 'number' ? usage.completionTokens : 0;
    const totalTokens =
      typeof usage.totalTokens === 'number'
        ? usage.totalTokens
        : promptTokens + completionTokens;
    const rawHistory = session.flags?.[TOKEN_USAGE_HISTORY_FLAG];
    const historyEntries = Array.isArray(rawHistory)
      ? rawHistory
      : (
        typeof rawHistory === 'object' &&
        rawHistory !== null &&
        Array.isArray((rawHistory as { entries?: unknown[] }).entries)
          ? (rawHistory as { entries: Array<Record<string, unknown>> }).entries
          : []
      );
    const lastEntry =
      historyEntries.length > 0
        ? historyEntries[historyEntries.length - 1]
        : undefined;
    const historyPromptTokens =
      typeof lastEntry?.promptTokens === 'number'
        ? lastEntry.promptTokens
        : undefined;
    const lastTurnInputTokens = historyPromptTokens ?? promptTokens;
    return {
      ...usage,
      promptTokens,
      completionTokens,
      totalTokens,
      lastTurnInputTokens,
      contextWindow: session.modelContextWindow ?? usage.contextWindow ?? null,
      contextRemaining:
        typeof session.modelContextWindow === 'number'
          ? Math.max(session.modelContextWindow - lastTurnInputTokens, 0)
          : usage.contextRemaining ?? null,
    };
  };

  const buildBootstrapSnapshot = async (session: SessionState) => {
    const completed = (session.flags?.session as Record<string, unknown> | undefined)?.completed === true;
    const blockedReason = getBlockedReason(session);
    const derivedState = deriveSessionEventState({
      ...session,
      completed,
    });
    const execution = resolveRunnerSessionBinding(session);
    const executionReadModel = await services.sessionStore.getExecutionReadModel(session.id);

    return {
      id: session.id,
      ...executionReadModel,
      userId: session.userId,
      title: session.title ?? session.task?.title ?? null,
      status: derivedState.status,
      pause_reason: derivedState.pauseReason,
      interaction_type: derivedState.interactionType,
      blocked_reason: blockedReason ?? undefined,
      isProcessing: session.stateMachine?.isProcessing() ?? false,
      completed,
      mode: session.mode,
      version: session.version ?? 0,
      createdAt: session.createdAt,
      lastActive: session.lastActive,
      turn: session.turn,
      summary: session.summary,
      report:
        typeof (session as SessionState & { report?: unknown }).report === 'string'
          ? ((session as SessionState & { report?: string }).report ?? undefined)
          : undefined,
      messages: (session.messages ?? [])
        .filter(isVisibleMessage)
        .map(toMessageResponse),
      plan: session.plan ?? [],
      usage: toUsageResponse(session),
      artifacts: (session.artifacts ?? []).map(toArtifactResponse),
      liveToolStreams: session.liveToolStreams ?? {},
      timeline: session.timeline ?? [],
      task: session.task ? { id: session.task.id, title: session.task.title } : undefined,
      executionTarget: execution.executionTarget,
      runnerId: execution.runnerId,
      runnerName: execution.runnerName,
    };
  };

  const isResponseClosed = (response: {
    writableEnded: boolean;
    socket?: { destroyed?: boolean } | null;
  }): boolean => {
    if (response.writableEnded) {
      return true;
    }
    const destroyed = (response as { destroyed?: boolean }).destroyed;
    return Boolean(destroyed ?? response.socket?.destroyed);
  };

  const sseHandler: RequestHandler = async (req, res, next) => {
    try {
      const { id: sessionId } = req.params;

      const session = await services.sessionStore.getOrHydrate(sessionId);
      if (!session) {
        throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Session not found', {
          context: { sessionId },
        });
      }

      const authedReq = req as AuthenticatedRequest;
      ensureSessionExists(session, sessionId);
      ensureSessionAccess(session, authedReq);
      await assertRunObservabilityAccess({
        session,
        req: authedReq,
        accessControl: getAccessControl(),
      });

      const allowedOrigin = res.getHeader('access-control-allow-origin');
      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      };
      if (allowedOrigin) {
        headers['Access-Control-Allow-Origin'] = String(allowedOrigin);
      }

      res.writeHead(200, headers);
      res.flushHeaders?.();

      try {
        const bootstrapPayload = JSON.stringify(await buildBootstrapSnapshot(session));
        res.write('event: session.bootstrap\n');
        res.write(`data: ${bootstrapPayload}\n\n`);
      } catch (error) {
        const appErr = toAppError(error);
        console.error(`Failed to send bootstrap SSE event for session ${sessionId}:`, appErr);
      }

      const heartbeatInterval = setInterval(() => {
        if (isResponseClosed(res)) {
          clearInterval(heartbeatInterval);
          return;
        }
        res.write('event: ping\n');
        res.write(`data: {"timestamp":"${new Date().toISOString()}"}\n\n`);
      }, SSE_KEEPALIVE_MS);

      const unsubscribe = services.ports.events.subscribe(sessionId, (event) => {
        if (isResponseClosed(res)) {
          return;
        }
        try {
          const payload =
            'data' in event
              ? JSON.stringify(event.data ?? {})
              : JSON.stringify({});
          res.write(`event: ${event.type}\n`);
          res.write(`data: ${payload}\n\n`);
        } catch (error) {
          const appErr = toAppError(error);
          console.error(`Failed to send SSE event for session ${sessionId}:`, appErr);
        }
      });

      // Emit the cached sandbox policy immediately if available so late subscribers see it.
      void services.agentEngine
        .getSandboxPolicy(sessionId)
        .then((policy) => {
          if (!policy) {
            return;
          }
          try {
            const payload = JSON.stringify(policy);
            res.write('event: sandbox_policy\n');
            res.write(`data: ${payload}\n\n`);
          } catch (error) {
            const appErr = toAppError(error);
            console.error(
              `Failed to send initial sandbox policy for session ${sessionId}:`,
              appErr,
            );
          }
        })
        .catch((error) => {
          const appErr = toAppError(error);
          console.error(
            `Failed to fetch sandbox policy for session ${sessionId}:`,
            appErr,
          );
        });

      const cleanup = () => {
        clearInterval(heartbeatInterval);
        unsubscribe();
      };

      req.once('close', cleanup);
      req.once('error', cleanup);
      res.once('close', cleanup);
    } catch (error) {
      next(error);
    }
  };

  router.get(
    '/sessions/:id/stream',
    validate({ params: sessionStreamParamsSchema, query: sessionStreamQueryParamsSchema }),
    sseHandler,
  );

  return router;
};







