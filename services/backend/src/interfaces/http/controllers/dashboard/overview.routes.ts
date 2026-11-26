import { type Router } from 'express';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  assets,
  automations,
  codeSources,
  findingEvents,
  findings,
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
  parseDays,
  buildWindow,
  normalizeRunDashboardStatus,
  deriveTrajectory,
  roundTo,
  buildSecurityPosture,
  createEmptyMix,
  buildHeatmapSeries,
  buildActiveFindingClauses,
  getFindingTrendSeries
} from './shared';
import type { DashboardRouterContext } from './shared';

export function registerDashboardOverviewRoutes(router: Router, context: DashboardRouterContext): void {
  const { getOrgId, runActivityService } = context;
  router.get('/overview-v2', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId, days: daysParam } = req.query as Record<string, string | undefined>;
      const window = buildWindow(parseDays(daysParam));

      const findingsWhere = buildActiveFindingClauses(orgId, scopeId);
      const trendData = await getFindingTrendSeries(orgId, scopeId, window);

      const [
        findingStats,
        validationStatsRows,
        mttrRows,
        runCountRows,
        activeRunCountRows,
        recentRunRows,
        statusRows,
        triggerRows,
        nextRunRows,
        topAffectedRows,
        owaspRows,
      ] = await Promise.all([
        db
          .select({
            severity: findings.severity,
            state: findings.state,
            count: count(),
          })
          .from(findings)
          .where(and(...findingsWhere))
          .groupBy(findings.severity, findings.state),
        db
          .select({
            activeCount: count(),
            validatedCount: sql<number>`COUNT(*) FILTER (WHERE ${findings.state} = 'confirmed')::int`,
          })
          .from(findings)
          .where(
            and(
              ...buildActiveFindingClauses(orgId, scopeId, [inArray(findings.state, ['potential', 'verifying', 'confirmed', 'not_reproduced'])]),
            ),
          ),
        db
          .select({
            findingId: findings.id,
            findingCreatedAt: findings.createdAt,
            resolvedAt: sql<Date>`MIN(${findingEvents.createdAt})`,
          })
          .from(findingEvents)
          .innerJoin(findings, eq(findings.id, findingEvents.findingId))
          .where(
            and(
              eq(findingEvents.organizationId, orgId),
              scopeId ? eq(findings.scopeId, scopeId) : undefined,
              sql`${findings.state} <> 'dismissed'`,
              sql`${findingEvents.createdAt} >= ${window.since}`,
              eq(findingEvents.type, 'state_changed'),
              eq(findingEvents.toState, 'resolved'),
            ),
          )
          .groupBy(findings.id, findings.createdAt),
        db
          .select({
            date: sql<string>`to_char(${runs.createdAt}, 'YYYY-MM-DD')`,
            count: count(),
          })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, orgId),
              scopeId ? eq(runs.scopeId, scopeId) : undefined,
              sql`${runs.createdAt} >= ${window.since}`,
            ),
          )
          .groupBy(sql`to_char(${runs.createdAt}, 'YYYY-MM-DD')`),
        db
          .select({ count: count() })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, orgId),
              scopeId ? eq(runs.scopeId, scopeId) : undefined,
              inArray(runs.status, ['queued', 'running']),
            ),
          ),
        db
          .select({
            id: runs.id,
            displayId: runs.displayId,
            title: runs.title,
            goal: runs.goal,
            status: runs.status,
            createdAt: runs.createdAt,
          })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, orgId),
              scopeId ? eq(runs.scopeId, scopeId) : undefined,
            ),
          )
          .orderBy(desc(runs.createdAt))
          .limit(5),
        db
          .select({
            status: runs.status,
            count: count(),
          })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, orgId),
              scopeId ? eq(runs.scopeId, scopeId) : undefined,
              sql`${runs.createdAt} >= ${window.since}`,
            ),
          )
          .groupBy(runs.status),
        db
          .select({
            trigger: runs.trigger,
            count: count(),
          })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, orgId),
              scopeId ? eq(runs.scopeId, scopeId) : undefined,
              sql`${runs.createdAt} >= ${window.since}`,
            ),
          )
          .groupBy(runs.trigger),
        db
          .select({ nextRunAt: sql<Date | null>`min(${automations.nextRunAt})` })
          .from(automations)
          .where(
            and(
              eq(automations.organizationId, orgId),
              scopeId ? eq(automations.scopeId, scopeId) : undefined,
              eq(automations.isActive, true),
              sql`${automations.nextRunAt} IS NOT NULL`,
            ),
          ),
        db
          .select({
            assetId: findings.assetId,
            weightedRisk: sql<number>`
              SUM(
                CASE ${findings.severity}
                  WHEN 'critical' THEN 8
                  WHEN 'high' THEN 5
                  WHEN 'medium' THEN 3
                  WHEN 'low' THEN 1
                  ELSE 0
                END
              )::int
            `,
            openCount: sql<number>`COUNT(*)::int`,
            criticalCount: sql<number>`COUNT(*) FILTER (WHERE ${findings.severity} = 'critical')::int`,
            highCount: sql<number>`COUNT(*) FILTER (WHERE ${findings.severity} = 'high')::int`,
            lastSeenAt: sql<Date | null>`MAX(${findings.lastSeenAt})`,
          })
          .from(findings)
          .where(
            and(
              ...buildActiveFindingClauses(orgId, scopeId, [inArray(findings.state, ['potential', 'verifying', 'confirmed', 'not_reproduced'])]),
            ),
          )
          .groupBy(findings.assetId)
          .orderBy(
            desc(sql<number>`
              SUM(
                CASE ${findings.severity}
                  WHEN 'critical' THEN 8
                  WHEN 'high' THEN 5
                  WHEN 'medium' THEN 3
                  WHEN 'low' THEN 1
                  ELSE 0
                END
              )::int
            `),
            desc(sql<number>`COUNT(*)::int`),
            desc(sql<Date | null>`MAX(${findings.lastSeenAt})`),
          )
          .limit(5),
        db
          .select({
            owaspCategory: findings.owaspCategory,
            count: count(),
          })
          .from(findings)
          .where(and(...buildActiveFindingClauses(orgId, scopeId, [sql`${findings.owaspCategory} IS NOT NULL`])))
          .groupBy(findings.owaspCategory)
          .orderBy(desc(sql`count(*)`)),
      ]);

      let criticalOpen = 0;
      let highOpen = 0;
      let mediumOpen = 0;
      let lowOpen = 0;
      let infoOpen = 0;
      let activeBacklog = 0;

      for (const row of findingStats) {
        if (row.state === 'dismissed') continue;
        const countValue = Number(row.count);
        const isActiveBacklogStatus = ['potential', 'verifying', 'confirmed', 'not_reproduced'].includes(row.state);

        if (isActiveBacklogStatus) {
          activeBacklog += countValue;
        }

        if (!isActiveBacklogStatus) continue;

        if (row.severity === 'critical') criticalOpen += countValue;
        if (row.severity === 'high') highOpen += countValue;
        if (row.severity === 'medium') mediumOpen += countValue;
        if (row.severity === 'low') lowOpen += countValue;
        if (row.severity === 'info') infoOpen += countValue;
      }

      const totalDurationHours = mttrRows.reduce((sum, row) => {
        const findingCreatedAt = row.findingCreatedAt instanceof Date ? row.findingCreatedAt : new Date(row.findingCreatedAt);
        const resolvedAt = row.resolvedAt instanceof Date ? row.resolvedAt : new Date(row.resolvedAt);
        const durationMs = resolvedAt.getTime() - findingCreatedAt.getTime();
        return Number.isFinite(durationMs) && durationMs >= 0 ? sum + durationMs / (1000 * 60 * 60) : sum;
      }, 0);

      const activeCount = Number(validationStatsRows[0]?.activeCount ?? 0);
      const validatedCount = Number(validationStatsRows[0]?.validatedCount ?? 0);
      const mttrHours = mttrRows.length > 0 ? roundTo(totalDurationHours / mttrRows.length, 2) : null;
      const validationRate = activeCount > 0 ? roundTo(validatedCount / activeCount, 4) : 0;
      const remediationVelocity =
        trendData.createdInWindow > 0 ? roundTo(trendData.resolvedInWindow / trendData.createdInWindow, 4) : null;
      const countsByDate = new Map(runCountRows.map((row) => [row.date, Number(row.count)]));
      const runsInWindow =
        countsByDate.size > 0
          ? Array.from(countsByDate.values()).reduce((sum, value) => sum + value, 0)
          : 0;
      const trajectory = deriveTrajectory({ backlogDelta: trendData.backlogDelta });
      const securityPosture = buildSecurityPosture({
        criticalOpen,
        highOpen,
        mediumOpen,
        lowOpen,
        infoOpen,
        activeBacklog,
        validatedOpenCount: validatedCount,
        remediationVelocity,
        createdInWindow: trendData.createdInWindow,
        resolvedInWindow: trendData.resolvedInWindow,
        runsInWindow,
        trend: trajectory,
      });

      const statusMixMap = new Map<string, number>();
      for (const row of statusRows) {
        const normalizedStatus = normalizeRunDashboardStatus(normalizeString(row.status));
        statusMixMap.set(normalizedStatus, (statusMixMap.get(normalizedStatus) ?? 0) + Number(row.count));
      }

      const statusMixEntries = createEmptyMix(
        Array.from(statusMixMap.entries())
          .map(([key, countValue]) => ({ key, count: countValue }))
          .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
      );
      const triggerMixEntries = createEmptyMix(
        triggerRows
          .map((row) => ({
            key: normalizeString(row.trigger) || 'unknown',
            count: Number(row.count),
          }))
          .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
      );

      const assetIds = topAffectedRows.map((row) => row.assetId).filter((assetId): assetId is string => Boolean(assetId));
      const assetMap = new Map<string, string>();
      if (assetIds.length > 0) {
        const assetRows = await db.select({ id: assets.id, value: assets.value }).from(assets).where(inArray(assets.id, assetIds));
        for (const asset of assetRows) {
          assetMap.set(asset.id, asset.value);
        }
      }

      let readiness = {
        targetState: 'missing' as 'missing' | 'pending' | 'verified',
        runnerState: 'not_required' as 'not_required' | 'missing' | 'offline' | 'ready',
        accessMaterialsCount: 0,
        connectedRepoCount: 0,
        whiteboxEnabled: false,
        activeAutomations: 0,
      };

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

        readiness = {
          targetState: targetCount === 0 ? 'missing' : verifiedTargetCount > 0 ? 'verified' : 'pending',
          runnerState:
            assignedRunnerCount === 0
              ? 'not_required'
              : onlineRunnerCount === 0
                ? 'offline'
                : 'ready',
          accessMaterialsCount,
          connectedRepoCount,
          whiteboxEnabled: connectedRepoCount > 0,
          activeAutomations,
        };
      }

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

      const latestActivity = latestRun
        ? await runActivityService.getSummaryForRun({
            id: latestRun.id,
            sessionId: latestRun.sessionId,
            plannerSessionId: latestRun.plannerSessionId,
            executorSessionId: latestRun.executorSessionId,
          })
        : null;

      res.json({
        window: {
          days: window.days,
          from: window.from,
          to: window.to,
        },
        posture: {
          criticalOpen,
          highOpen,
          activeBacklog,
          resolvedInWindow: trendData.resolvedInWindow,
          mttrHours,
          runsInWindow,
          trajectory,
        },
        securityPosture,
        activeRuns: Number(activeRunCountRows[0]?.count ?? 0),
        recentRuns: recentRunRows.map((run) => ({
          ...run,
          createdAt: toIsoString(run.createdAt),
        })),
        lifecycle: {
          trend: trendData.trends,
          validationRate,
          remediationVelocity,
          backlogDelta: trendData.backlogDelta,
        },
        cadence: {
          heatmap: buildHeatmapSeries(window, countsByDate),
          statusMix: Object.fromEntries(statusMixEntries.map((entry) => [entry.key, entry.count])),
          triggerMix: Object.fromEntries(triggerMixEntries.map((entry) => [entry.key, entry.count])),
          nextScheduledRun: toIsoString(nextRunRows[0]?.nextRunAt),
        },
        assets: {
          topAffected: topAffectedRows.map((row) => ({
            assetId: row.assetId,
            assetValue: row.assetId ? assetMap.get(row.assetId) ?? row.assetId : 'Unknown Asset',
            weightedRisk: Number(row.weightedRisk ?? 0),
            openCount: Number(row.openCount ?? 0),
            criticalCount: Number(row.criticalCount ?? 0),
            highCount: Number(row.highCount ?? 0),
            lastSeenAt: toIsoString(row.lastSeenAt),
          })),
        },
        categories: {
          owasp: owaspRows.flatMap((row) =>
            row.owaspCategory
              ? [
                  {
                    category: row.owaspCategory,
                    count: Number(row.count),
                  },
                ]
              : [],
          ),
        },
        readiness,
        latestActivity: latestRun && latestActivity
          ? {
              runId: latestRun.id,
              title: normalizeString(latestRun.title) || normalizeString(latestRun.goal) || 'Recent run',
              createdAt: toIsoString(latestRun.createdAt),
              totals: {
                requests: latestActivity.totals.requests,
                uniqueHosts: latestActivity.totals.uniqueHosts,
                uniqueEndpoints: latestActivity.totals.uniqueEndpoints,
                blockedActions: latestActivity.totals.blockedActions,
              },
            }
          : null,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[dashboard] Failed to get overview-v2');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get dashboard overview' });
    }
  });
}
