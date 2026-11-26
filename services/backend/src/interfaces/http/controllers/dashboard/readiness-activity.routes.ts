import { type Router } from 'express';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  automations,
  codeSources,
  runs,
  runnerScopeAssignments,
  runners,
  scopeAccessMaterials,
  scopes,
  scopeTargets,
} from '@/db/schema';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

import {
  TERMINAL_RUN_STATUSES,
  normalizeString,
  toIsoString,
} from './shared';
import type { DashboardRouterContext } from './shared';

export function registerDashboardReadinessActivityRoutes(router: Router, context: DashboardRouterContext): void {
  const { getOrgId, runActivityService, complianceReadinessService } = context;
  router.get('/readiness', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId } = req.query as Record<string, string | undefined>;

      if (!scopeId) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'scopeId is required',
        });
      }

      const [scopeRow] = await db
        .select({
          id: scopes.id,
        })
        .from(scopes)
        .where(and(eq(scopes.organizationId, orgId), eq(scopes.id, scopeId)))
        .limit(1);

      if (!scopeRow) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Scope not found',
        });
      }

      const [targetCountsRows, repoCountRows, accessMaterialCountRows, automationCountRows, runnerRows] = await Promise.all([
        db
          .select({
            total: count(),
            verified: sql<number>`COUNT(*) FILTER (WHERE ${scopeTargets.verified} = true)::int`,
          })
          .from(scopeTargets)
          .where(eq(scopeTargets.scopeId, scopeId)),
        db
          .select({ count: count() })
          .from(codeSources)
          .where(and(eq(codeSources.organizationId, orgId), eq(codeSources.scopeId, scopeId), eq(codeSources.status, 'ready'))),
        db
          .select({ count: count() })
          .from(scopeAccessMaterials)
          .where(and(eq(scopeAccessMaterials.organizationId, orgId), eq(scopeAccessMaterials.scopeId, scopeId))),
        db
          .select({ count: count() })
          .from(automations)
          .where(and(eq(automations.organizationId, orgId), eq(automations.scopeId, scopeId), eq(automations.isActive, true))),
        db
          .select({ status: runners.status })
          .from(runnerScopeAssignments)
          .innerJoin(runners, eq(runners.id, runnerScopeAssignments.runnerId))
          .where(and(eq(runnerScopeAssignments.scopeId, scopeId), eq(runners.organizationId, orgId))),
      ]);

      const targetCount = Number(targetCountsRows[0]?.total ?? 0);
      const verifiedTargetCount = Number(targetCountsRows[0]?.verified ?? 0);
      // The scope's code source, once ready, is its one connected repository.
      const connectedRepoCount = Number(repoCountRows[0]?.count ?? 0);
      const accessMaterialsCount = Number(accessMaterialCountRows[0]?.count ?? 0);
      const activeAutomations = Number(automationCountRows[0]?.count ?? 0);
      const assignedRunnerCount = runnerRows.length;
      const onlineRunnerCount = runnerRows.filter((runner) => ['online', 'busy'].includes(normalizeString(runner.status))).length;

      res.json({
        scopeId,
        targetState: targetCount === 0 ? 'missing' : verifiedTargetCount > 0 ? 'verified' : 'pending',
        targetCount,
        verifiedTargetCount,
        scopeExecutionNetwork: 'external',
        runnerState:
          assignedRunnerCount === 0
            ? 'not_required'
            : onlineRunnerCount === 0
              ? 'offline'
              : 'ready',
        assignedRunnerCount,
        onlineRunnerCount,
        accessMaterialsCount,
        connectedRepoCount,
        whiteboxEnabled: connectedRepoCount > 0,
        activeAutomations,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[dashboard] Failed to get readiness');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get dashboard readiness' });
    }
  });

  router.get('/compliance-readiness', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId } = req.query as Record<string, string | undefined>;

      if (scopeId) {
        const [scopeRow] = await db
          .select({ id: scopes.id })
          .from(scopes)
          .where(and(eq(scopes.organizationId, orgId), eq(scopes.id, scopeId)))
          .limit(1);

        if (!scopeRow) {
          return sendApiError(res, {
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Scope not found',
          });
        }
      }

      const readiness = await complianceReadinessService.getScopeReadiness({
        organizationId: orgId,
        scopeId: scopeId ?? null,
      });
      res.json(readiness);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[dashboard] Failed to get compliance readiness');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get compliance readiness',
      });
    }
  });

  router.get('/latest-activity', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId } = req.query as Record<string, string | undefined>;

      const [latestRun] = await db
        .select({
          id: runs.id,
          scopeId: runs.scopeId,
          title: runs.title,
          goal: runs.goal,
          status: runs.status,
          trigger: runs.trigger,
          createdAt: runs.createdAt,
          completedAt: runs.completedAt,
          sessionId: runs.sessionId,
          plannerSessionId: runs.plannerSessionId,
          executorSessionId: runs.executorSessionId,
        })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, orgId),
            scopeId ? eq(runs.scopeId, scopeId) : undefined,
            inArray(runs.status, [...TERMINAL_RUN_STATUSES]),
          ),
        )
        .orderBy(desc(sql`COALESCE(${runs.completedAt}, ${runs.createdAt})`))
        .limit(1);

      if (!latestRun) {
        return res.json({ latestActivity: null });
      }

      const activity = await runActivityService.getSummaryForRun({
        id: latestRun.id,
        sessionId: latestRun.sessionId,
        plannerSessionId: latestRun.plannerSessionId,
        executorSessionId: latestRun.executorSessionId,
      });

      res.json({
        latestActivity: {
          runId: latestRun.id,
          scopeId: latestRun.scopeId,
          title: normalizeString(latestRun.title) || normalizeString(latestRun.goal) || 'Recent run',
          createdAt: toIsoString(latestRun.createdAt),
          completedAt: toIsoString(latestRun.completedAt),
          status: latestRun.status,
          trigger: latestRun.trigger,
          generatedAt: activity.generatedAt,
          totals: {
            requests: activity.totals.requests,
            uniqueHosts: activity.totals.uniqueHosts,
            uniqueEndpoints: activity.totals.uniqueEndpoints,
            blockedActions: activity.totals.blockedActions,
          },
        },
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[dashboard] Failed to get latest activity');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get latest dashboard activity' });
    }
  });
}
