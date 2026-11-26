import express, { Router } from 'express';
import request from 'supertest';
import { describe, it, vi } from 'vitest';

import { registerDashboardOverviewRoutes } from '@/interfaces/http/controllers/dashboard/overview.routes';
import type { DashboardRouterContext } from '@/interfaces/http/controllers/dashboard/shared';

describe('dashboard overview routes', () => {
  it('has no Watch service status route: the Watch product is not part of Null AI', async () => {
    const router = Router();
    registerDashboardOverviewRoutes(router, {
      getOrgId: vi.fn().mockResolvedValue('org-1'),
      runActivityService: {} as DashboardRouterContext['runActivityService'],
      complianceReadinessService: {} as DashboardRouterContext['complianceReadinessService'],
    });
    const app = express();
    app.use(router);

    await request(app).get('/service-status').expect(404);
  });
});
