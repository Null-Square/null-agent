import { type Router } from 'express';
import { and, count, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  assets,
  automations,
  findings,
  runs,
  runners,
  scopes,
} from '@/db/schema';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { confirmedAssetClause } from '@/domains/security-ops/assets/assetConfirmation';

import {
  buildWindow,
  deriveTrajectory,
  roundTo,
  buildSecurityPosture,
  isSqlClause,
  buildActiveFindingClauses,
  getFindingTrendSeries
} from './shared';
import type { DashboardRouterContext } from './shared';

export function registerDashboardSummaryRoutes(router: Router, context: DashboardRouterContext): void {
  const { getOrgId } = context;
  router.get('/summary', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const { scopeId } = req.query as Record<string, string | undefined>;

      const findingsWhere = buildActiveFindingClauses(orgId, scopeId);

      const findingStats = await db
        .select({
          severity: findings.severity,
          state: findings.state,
          count: count(),
        })
        .from(findings)
        .where(and(...findingsWhere))
        .groupBy(findings.severity, findings.state);

      let criticalCount = 0;
      let highCount = 0;
      let mediumCount = 0;
      let lowCount = 0;
      let infoCount = 0;
      let openCount = 0;
      let resolvedCount = 0;
      let validatedCount = 0;
      let activeBacklog = 0;
      let validatedOpenCount = 0;
      let criticalOpenCount = 0;
      let highOpenCount = 0;
      let mediumOpenCount = 0;
      let lowOpenCount = 0;
      let infoOpenCount = 0;

      for (const row of findingStats) {
        if (row.state === 'dismissed') continue;
        const countValue = Number(row.count);
        const isActiveBacklogStatus = ['potential', 'verifying', 'confirmed', 'not_reproduced'].includes(row.state);

        switch (row.severity) {
          case 'critical':
            criticalCount += countValue;
            if (isActiveBacklogStatus) criticalOpenCount += countValue;
            break;
          case 'high':
            highCount += countValue;
            if (isActiveBacklogStatus) highOpenCount += countValue;
            break;
          case 'medium':
            mediumCount += countValue;
            if (isActiveBacklogStatus) mediumOpenCount += countValue;
            break;
          case 'low':
            lowCount += countValue;
            if (isActiveBacklogStatus) lowOpenCount += countValue;
            break;
          case 'info':
            infoCount += countValue;
            if (isActiveBacklogStatus) infoOpenCount += countValue;
            break;
        }
        if (isActiveBacklogStatus) openCount += countValue;
        if (row.state === 'resolved') resolvedCount += countValue;
        if (['confirmed', 'resolved', 'accepted'].includes(row.state)) validatedCount += countValue;
        if (isActiveBacklogStatus) {
          activeBacklog += countValue;
          if (row.state === 'confirmed') {
            validatedOpenCount += countValue;
          }
        }
      }

      const assetsWhere = [
        eq(assets.organizationId, orgId),
        confirmedAssetClause(scopeId),
      ].filter(isSqlClause);

      const [assetCountRow] = await db.select({ count: count() }).from(assets).where(and(...assetsWhere));
      const [scopeCountRow] = await db
        .select({ count: count() })
        .from(scopes)
        .where(eq(scopes.organizationId, orgId));
      const [activeRunsRow] = await db
        .select({ count: count() })
        .from(runs)
        .where(and(eq(runs.organizationId, orgId), scopeId ? eq(runs.scopeId, scopeId) : undefined, eq(runs.status, 'running')));
      const [runnersTotalRow] = await db
        .select({ count: count() })
        .from(runners)
        .where(eq(runners.organizationId, orgId));
      const [runnersOnlineRow] = await db
        .select({ count: count() })
        .from(runners)
        .where(and(eq(runners.organizationId, orgId), inArray(runners.status, ['online', 'busy'])));
      const [activeAutomationsRow] = await db
        .select({ count: count() })
        .from(automations)
        .where(and(eq(automations.organizationId, orgId), eq(automations.isActive, true)));
      const [nextRunRow] = await db
        .select({ nextRunAt: sql<Date | null>`min(${automations.nextRunAt})` })
        .from(automations)
        .where(
          and(
            eq(automations.organizationId, orgId),
            eq(automations.isActive, true),
            sql`${automations.nextRunAt} IS NOT NULL`,
          ),
        );

      const postureWindow = buildWindow(30);
      const trendData = await getFindingTrendSeries(orgId, scopeId, postureWindow);

      const [runsInWindowRow] = await db
        .select({ count: count() })
        .from(runs)
        .where(
          and(
            eq(runs.organizationId, orgId),
            scopeId ? eq(runs.scopeId, scopeId) : undefined,
            sql`${runs.createdAt} >= ${postureWindow.since}`,
          ),
        );

      const createdInWindow = trendData.createdInWindow;
      const resolvedInWindow = trendData.resolvedInWindow;
      const runsInWindow = Number(runsInWindowRow?.count ?? 0);
      const remediationVelocity =
        createdInWindow > 0 ? roundTo(resolvedInWindow / createdInWindow, 4) : null;
      const securityPosture = buildSecurityPosture({
        criticalOpen: criticalOpenCount,
        highOpen: highOpenCount,
        mediumOpen: mediumOpenCount,
        lowOpen: lowOpenCount,
        infoOpen: infoOpenCount,
        activeBacklog,
        validatedOpenCount,
        remediationVelocity,
        createdInWindow,
        resolvedInWindow,
        runsInWindow,
        trend: deriveTrajectory({
          backlogDelta: trendData.backlogDelta,
        }),
      });

      res.json({
        criticalCount,
        highCount,
        mediumCount,
        lowCount,
        infoCount,
        validatedCount,
        openCount,
        resolvedCount,
        totalAssets: Number(assetCountRow?.count ?? 0),
        totalScopes: Number(scopeCountRow?.count ?? 0),
        activeRuns: Number(activeRunsRow?.count ?? 0),
        runnersOnline: Number(runnersOnlineRow?.count ?? 0),
        runnersTotal: Number(runnersTotalRow?.count ?? 0),
        activeAutomations: Number(activeAutomationsRow?.count ?? 0),
        nextScheduledRun: nextRunRow?.nextRunAt instanceof Date ? nextRunRow.nextRunAt.toISOString() : null,
        securityPosture,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[dashboard] Failed to get summary');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get dashboard summary' });
    }
  });
}
