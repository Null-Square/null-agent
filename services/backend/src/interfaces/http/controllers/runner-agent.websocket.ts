import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Server } from 'http';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import type { AppContext } from '@/app/createAppContext';
import { db } from '@/db/client';
import { agentSessions, runEvents, runs } from '@/db/schema';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence';
import { RunnerService, type RunnerAuthContext } from '@/domains/security-ops/runners/RunnerService';
import { runnerConnectionRegistry } from '@/domains/security-ops/runners/RunnerConnectionRegistry';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { deriveSessionStatusForEvent, emitSessionStatusEvent } from '@/domains/agent-brain/application/orchestration/utils/sessionStatusEvents';
import { logger } from '@/shared/logger';

const RUNNER_CONNECT_PATH = '/api/app/runner-agent/connect';
const parseCsvHeader = (value: string | string[] | undefined): string[] => {
  const text = Array.isArray(value) ? value[0] : value;
  return String(text ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const parseBearerToken = (headerValue: string | string[] | undefined): string | null => {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer') {
    return null;
  }
  const token = parts[1];
  return token?.trim().length ? token.trim() : null;
};

const getPathname = (req: IncomingMessage): string => {
  try {
    const parsed = new URL(req.url || '/', 'http://localhost');
    return parsed.pathname;
  } catch {
    return '/';
  }
};

const writeHttpError = (socket: Duplex, statusCode: number, statusText: string, body: string): void => {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
};

export type RunnerWebSocketServerHandle = {
  close: () => Promise<void>;
};

const RUNNER_AFFECTED_RUN_STATUSES = [
  'running',
] as const;

export const attachRunnerAgentWebSocketServer = (
  server: Server,
  appContext?: Pick<AppContext, 'agentServices' | 'sessionStore'>,
): RunnerWebSocketServerHandle => {
  const log = logger.child({ scope: 'RunnerAgentWebSocket' });
  const runnerService = new RunnerService(db);
  const automationService = new AutomationService({ db });
  const auditService = new AuditService(db);
  const sessionRepository = new SessionRepository(db);
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });

  const notifyRunnerOffline = async (auth: RunnerAuthContext): Promise<void> => {
    const runnerName = await runnerService
      .getRunner(auth.organizationId, auth.runnerId)
      .then((runner) => runner.name)
      .catch(() => auth.runnerId);

    const payload = {
      runnerId: auth.runnerId,
      runnerName,
      status: 'offline',
      lastHeartbeatAt: new Date().toISOString(),
    };

    try {
      await automationService.evaluateEvent(auth.organizationId, {
        type: 'runner_offline',
        payload,
      });
    } catch (error) {
      log.warn(
        { err: error, runnerId: auth.runnerId, organizationId: auth.organizationId },
        '[runner-agent] Failed to dispatch runner_offline automation event',
      );
    }

  };

  const markRunnerBackedRunsUnavailable = async (auth: RunnerAuthContext): Promise<void> => {
    const impactedRuns = await db
      .select({
        id: runs.id,
        organizationId: runs.organizationId,
        sessionId: runs.sessionId,
        plannerSessionId: runs.plannerSessionId,
        executorSessionId: runs.executorSessionId,
      })
      .from(runs)
      .where(
        and(
          eq(runs.runnerId, auth.runnerId),
          inArray(runs.status, [...RUNNER_AFFECTED_RUN_STATUSES]),
        ),
      );

    if (impactedRuns.length === 0) {
      return;
    }

    const runIds = impactedRuns.map((run) => run.id);
    const primarySessionIds = Array.from(
      new Set(
        impactedRuns.flatMap((run) =>
          [run.sessionId, run.plannerSessionId, run.executorSessionId].filter(
            (value): value is string => typeof value === 'string' && value.length > 0,
          ),
        ),
      ),
    );
    const additionalSessionIds = (
      await Promise.all(impactedRuns.map((run) => sessionRepository.listIdsByRunId(run.id)))
    ).flat();
    const sessionIds = Array.from(new Set([...primarySessionIds, ...additionalSessionIds]));
    const now = new Date();

    await db
      .update(runs)
      .set({
        status: 'runner_unavailable',
        updatedAt: now,
      })
      .where(
        and(
          inArray(runs.id, runIds),
          inArray(runs.status, [...RUNNER_AFFECTED_RUN_STATUSES]),
        ),
      );

    await db.insert(runEvents).values(
      runIds.map((runId) => ({
        runId,
        type: 'runner_unavailable',
        note: 'Assigned private runner disconnected during execution.',
      })),
    );

    if (sessionIds.length > 0) {
      await db
        .update(agentSessions)
        .set({
          blockedReason: 'runner_unavailable',
          updatedAt: now,
        })
        .where(
          and(
            inArray(agentSessions.id, sessionIds),
            eq(agentSessions.completed, false),
            isNull(agentSessions.blockedReason),
          ),
        );
    }

    if (!appContext) {
      return;
    }

    for (const sessionId of sessionIds) {
      const liveSession = appContext.sessionStore.get(sessionId);
      if (!liveSession) {
        continue;
      }

      const previousStatus = deriveSessionStatusForEvent(liveSession);

      try {
        await appContext.sessionStore.abortCurrentTurnAsync(sessionId, 'runner_unavailable');
      } catch (error) {
        log.warn(
          { err: error, runnerId: auth.runnerId, sessionId },
          '[runner-agent] Failed to abort active turn after runner disconnect',
        );
      }

      await appContext.sessionStore.setAsync(
        sessionId,
        {
          ...liveSession,
          blockedReason: 'runner_unavailable',
        },
        'runner.disconnected',
      );

      const updatedSession = appContext.sessionStore.get(sessionId);
      emitSessionStatusEvent(
        appContext.agentServices.ports.events,
        updatedSession ?? {
          ...liveSession,
          blockedReason: 'runner_unavailable',
        },
        previousStatus,
        'runner.unavailable',
        appContext.agentServices.traceRecorder,
      );
    }
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (getPathname(req) !== RUNNER_CONNECT_PATH) {
      return;
    }

    const token = parseBearerToken(req.headers.authorization);
    if (!token) {
      writeHttpError(socket, 401, 'Unauthorized', 'Runner bearer token is required');
      return;
    }

    void (async () => {
      let auth: RunnerAuthContext;
      try {
        auth = await runnerService.authenticateToken(token);
      } catch (error) {
        log.warn({ err: error }, '[runner-agent] WebSocket token auth failed');
        writeHttpError(socket, 401, 'Unauthorized', 'Invalid runner token');
        return;
      }

      const protocolVersionHeader = req.headers['x-runner-protocol-version']?.toString().trim();
      const protocolVersion = Number(protocolVersionHeader ?? '0');
      const capabilities = parseCsvHeader(req.headers['x-runner-capabilities']);
      const missingCapabilities = runnerService
        .getRequiredRunnerCapabilities()
        .filter((capability) => !capabilities.includes(capability));
      if (
        !Number.isFinite(protocolVersion) ||
        protocolVersion < runnerService.getRequiredRunnerProtocolVersion() ||
        missingCapabilities.length > 0
      ) {
        const message = `Runner upgrade required. Expected protocol ${runnerService.getRequiredRunnerProtocolVersion()} and capabilities ${runnerService.getRequiredRunnerCapabilities().join(', ')}.`;
        void runnerService.markConnectionRejected(auth, {
          reason: 'upgrade_required',
          message,
          protocolVersion: Number.isFinite(protocolVersion) ? protocolVersion : 0,
          capabilities,
        }).catch((error) => {
          log.warn(
            { err: error, runnerId: auth.runnerId, organizationId: auth.organizationId },
            '[runner-agent] Failed to persist runner upgrade-required health state',
          );
        });
        writeHttpError(
          socket,
          426,
          'Upgrade Required',
          message,
        );
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        const ipAddress =
          req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
          req.socket.remoteAddress ||
          null;
        const userAgent = req.headers['user-agent']?.toString().trim();
        const versionHeader = req.headers['x-runner-version']?.toString().trim();
        const platformHeader = req.headers['x-runner-platform']?.toString().trim();
        const networkAddressesHeader = req.headers['x-runner-network-addresses']?.toString().trim();

        runnerConnectionRegistry.register(auth.runnerId, ws);

        void runnerService
          .markOnline(auth, {
            version: versionHeader || userAgent || 'shell-server',
            ipAddress,
            metadata: {
              transport: 'websocket',
              runnerProtocolVersion: String(protocolVersion),
              capabilities: capabilities.join(','),
              ...(userAgent ? { userAgent } : {}),
              ...(platformHeader ? { platform: platformHeader } : {}),
              ...(networkAddressesHeader ? { runnerNetworkAddresses: networkAddressesHeader } : {}),
            },
          })
          .then(() => {
            return auditService.log({
              organizationId: auth.organizationId,
              actorId: auth.runnerId,
              actorType: 'runner',
              action: 'runner.connected',
              resourceType: 'runner',
              resourceId: auth.runnerId,
              metadata: { ipAddress, version: versionHeader || userAgent || 'shell-server' },
            });
          })
          .catch((error) => {
            log.warn(
              { err: error, runnerId: auth.runnerId },
              '[runner-agent] Failed to mark runner online or write audit log',
            );
          });

        ws.on('message', (payload) => {
          runnerConnectionRegistry.handleIncomingMessage(auth.runnerId, payload);
          void runnerService.touchHeartbeat(auth.runnerId).catch((error) => {
            log.warn(
              { err: error, runnerId: auth.runnerId },
              '[runner-agent] Failed to touch runner heartbeat',
            );
          });
        });

        ws.on('ping', () => {
          void runnerService.touchHeartbeat(auth.runnerId).catch((error) => {
            log.warn(
              { err: error, runnerId: auth.runnerId },
              '[runner-agent] Failed to touch heartbeat from ping',
            );
          });
        });

        ws.on('close', () => {
          runnerConnectionRegistry.unregister(auth.runnerId, ws);
          if (runnerConnectionRegistry.isConnected(auth.runnerId)) {
            return;
          }
          void (async () => {
            try {
              await runnerService.markOffline(auth.runnerId, {
                state: 'offline',
                reason: 'runner_disconnected',
                message: 'Runner disconnected from control plane. Waiting for reconnect.',
              });
            } catch (error) {
              log.warn(
                { err: error, runnerId: auth.runnerId },
                '[runner-agent] Failed to mark runner offline',
              );
              return;
            }

            void auditService
              .log({
                organizationId: auth.organizationId,
                actorId: auth.runnerId,
                actorType: 'runner',
                action: 'runner.disconnected',
                resourceType: 'runner',
                resourceId: auth.runnerId,
                metadata: {},
              })
              .catch((error) => {
                log.warn(
                  { err: error, runnerId: auth.runnerId },
                  '[runner-agent] Failed to write runner disconnect audit log',
                );
              });

            await notifyRunnerOffline(auth);
            await markRunnerBackedRunsUnavailable(auth);
          })();
        });

        ws.on('error', (error) => {
          log.warn({ err: error, runnerId: auth.runnerId }, '[runner-agent] Runner websocket error');
        });

        ws.send(JSON.stringify({ type: 'connected', runnerId: auth.runnerId }));
      });
    })();
  };

  server.on('upgrade', onUpgrade);

  return {
    close: async () => {
      server.off('upgrade', onUpgrade);
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
};
