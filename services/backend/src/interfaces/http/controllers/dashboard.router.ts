import { Router } from 'express';

import { db } from '@/db/client';
import { ComplianceReadinessService } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { authMiddleware } from '@/shared/middleware/auth.middleware';

import { registerDashboardOverviewRoutes } from './dashboard/overview.routes';
import { registerDashboardReadinessActivityRoutes } from './dashboard/readiness-activity.routes';
import { registerDashboardSummaryRoutes } from './dashboard/summary.routes';
import { createRunActivityService } from './dashboard/shared';
import type { DashboardRouteDeps, DashboardRouterContext } from './dashboard/shared';

export function createDashboardRouter(deps: DashboardRouteDeps = {}): Router {
  const router = Router();
  const orgService = deps.orgService ?? new OrganizationService(db);
  const runActivityService = deps.runActivityService ?? createRunActivityService(deps);
  const complianceReadinessService = new ComplianceReadinessService(db);

  router.use(authMiddleware);

  async function getOrgId(req: { user?: { id: string } }): Promise<string> {
    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    return org.id;
  }

  const context: DashboardRouterContext = {
    getOrgId,
    runActivityService,
    complianceReadinessService,
  };

  registerDashboardOverviewRoutes(router, context);
  registerDashboardSummaryRoutes(router, context);
  registerDashboardReadinessActivityRoutes(router, context);

  return router;
}
