import { Router } from 'express';
import { asyncHandler, validate } from '../middleware';
import { sessionIdParamSchema } from '../schemas';
import type { AgentApiServices } from '../types';
import { circuitBreakerRegistry } from '@/domains/agent-brain/application/services/CircuitBreaker';
import { deriveStatus } from '@/domains/agent-brain/domain/types';
import { AppError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

export const healthRouter = (services: AgentApiServices): Router => {
  const router = Router();
  const policyResolver = services.policyResolver;

  router.get(
    '/healthz',
    async (_req, res) => {
      const defaultPolicy = await policyResolver.getDefaultPolicy();
      res.status(200).json({ ok: true, time: Date.now(), sandboxPolicyDefault: Boolean(defaultPolicy) });
    },
  );

  /**
   * Deep health check with circuit breaker status and system info.
   * Use for monitoring dashboards and alerting.
   */
  router.get(
    '/health/deep',
    asyncHandler(async (_req, res) => {
      const circuitStats = circuitBreakerRegistry.getAllStats();
      const sessionCount = services.sessionStore.listSessions().length;

      // Check if any circuit is open
      const openCircuits = Object.entries(circuitStats)
        .filter(([_, stats]) => stats.state === 'OPEN')
        .map(([name]) => name);

      const healthy = openCircuits.length === 0;

      res.status(healthy ? 200 : 503).json({
        healthy,
        time: Date.now(),
        uptime: process.uptime(),
        sessions: {
          active: sessionCount,
        },
        circuits: {
          total: Object.keys(circuitStats).length,
          open: openCircuits,
          stats: circuitStats,
        },
        memory: {
          heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        },
      });
    }),
  );

  router.get(
    '/health/sessions',
    asyncHandler(async (_req, res) => {
      const sessions = services.sessionStore.listSessions();
      const total = sessions.length;
      const now = Date.now();
      const byStatus = sessions.reduce<Record<string, number>>((acc, session) => {
        // Use deriveStatus for consistent API responses (Dec 2025)
        const status = deriveStatus(session);
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {});
      const durations = sessions.map((s) => {
        const createdAt = Number.isFinite(s.createdAt) ? s.createdAt : now;
        return Math.max(0, now - createdAt);
      });
      const avgDurationMs = total > 0 ? durations.reduce((a, b) => a + b, 0) / total : 0;
      const mem = process.memoryUsage();
      const heapUsedMb = Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100;
      const rssMb = Math.round((mem.rss / 1024 / 1024) * 100) / 100;
      const perSessionMemoryMb = total > 0 ? Math.round((heapUsedMb / total) * 100) / 100 : 0;

      res.json({
        status: 'OK',
        totalActive: total,
        byStatus,
        avgDurationMs,
        perSessionMemoryMb,
        memory: {
          heapUsedMb,
          rssMb,
        },
      });
    }),
  );

  router.get(
    '/sessions/:id/health',
    validate({ params: sessionIdParamSchema }),
    asyncHandler(async (req, res) => {
      const { id: sessionId } = req.params;
      const session = services.sessionStore.get(sessionId);

      if (!session) {
        throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'Session not found', {
          context: { sessionId },
        });
      }

      const response = {
        sessionId,
        status: deriveStatus(session), // Use deriveStatus for consistent API responses
        turn: session.turn,
        lastActive: session.lastActive,
        sandbox: {
          mode: 'docker',
          containerId: session.containerId ?? null,
          connected: Boolean(session.containerId),
        },
      };

      res.status(200).json(response);
    }),
  );

  return router;
};
