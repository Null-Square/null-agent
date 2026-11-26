import { Router } from 'express';

import type { AuditService } from '@/domains/security-ops/audit/AuditService';
import type { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import { requirePrimaryOrgContext } from '@/interfaces/http/middleware/orgContext';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { authMiddleware } from '@/shared/middleware/auth.middleware';

const toIso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : (value ?? null);

const parseIsoDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

interface AuditLogsRouterDeps {
  orgService: OrganizationService;
  auditService: AuditService;
}

export function createAuditLogsRouter(deps: AuditLogsRouterDeps): Router {
  const router = Router();
  const { orgService, auditService } = deps;

  router.use(authMiddleware);

  router.get('/', requirePrimaryOrgContext, requireCapability('audit.read'), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }

      const orgId = req.organizationId ?? (await orgService.getForUser(userId)).id;
      const { limit, action, resourceType, from, to } = req.query as Record<string, string | undefined>;

      const parsedLimit = limit ? Number(limit) : 100;
      if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'limit must be a number between 1 and 500',
        });
      }

      const fromDate = parseIsoDate(from);
      const toDate = parseIsoDate(to);
      if ((from && !fromDate) || (to && !toDate)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'from and to must be valid ISO-8601 dates',
        });
      }

      const rows = await auditService.list(orgId, {
        limit: parsedLimit,
        action,
        resourceType,
        from: fromDate ?? undefined,
        to: toDate ?? undefined,
      });

      res.json(
        rows.map((row) => ({
          ...row,
          createdAt: toIso(row.createdAt),
        })),
      );
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[audit-logs] Failed to list audit logs');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to list audit logs',
      });
    }
  });

  return router;
}
