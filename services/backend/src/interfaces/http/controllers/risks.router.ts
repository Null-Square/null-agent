import { Router } from 'express';

import type { AccessControlService } from '@/app/services/platform/subscriptions/accessControlAppService';
import {
  RiskReadModelService,
  type RiskListItem,
  type RiskSummary,
} from '@/domains/security-ops/risks/RiskReadModelService';
import { roleHasCapability } from '@/shared/auth/capabilities';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  RiskDetailService,
  type CanonicalRiskDetail,
  type CodeOccurrenceRiskDetail,
} from '@/domains/security-ops/risks/RiskDetailService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RiskReader = {
  read(params: {
    organizationId: string;
    scopeId?: string | null;
    includeExposures: boolean;
  }): Promise<{ risks: RiskListItem[]; summary: RiskSummary }>;
};

type RiskDetailReader = {
  read(params: {
    organizationId: string;
    riskId: string;
    includeCodeSource: boolean;
    includeExposureSource: boolean;
  }): Promise<CanonicalRiskDetail | null>;
  readCodeOccurrence(params: {
    organizationId: string;
    occurrenceId: string;
  }): Promise<CodeOccurrenceRiskDetail | null>;
};

export function createRisksRouter(deps: {
  accessControl: Pick<
    AccessControlService,
    'resolveOrganizationSubscription' | 'enforceCodeReviewAccess'
  >;
  reader?: RiskReader;
  detailReader?: RiskDetailReader;
}): Router {
  const router = Router();
  const reader = deps.reader ?? new RiskReadModelService();
  const detailReader = deps.detailReader ?? new RiskDetailService();

  router.get('/', requireCapability('findings.read'), async (req, res) => {
    try {
      const organizationId = req.organizationId;
      const userId = req.user?.id;
      const scopeId = typeof req.query.scopeId === 'string' ? req.query.scopeId : undefined;

      if (!organizationId || !userId || !req.orgRole) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Organization context is required',
        });
      }
      if (scopeId && !UUID_RE.test(scopeId)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'scopeId must be a valid UUID',
        });
      }

      const subscription = await deps.accessControl.resolveOrganizationSubscription({
        userId,
        organizationId,
      });
      const includeExposures =
        subscription.plan.features?.accessThreatWatch === true
        && roleHasCapability(req.orgRole, 'threatwatch.read');

      const result = await reader.read({
        organizationId,
        scopeId,
        includeExposures,
      });
      return res.json(result);
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[risks] Failed to load risk read model');
      return sendApiError(res, {
        code: appError.code,
        message: appError.message,
        status: appError.httpStatus,
      });
    }
  });

  router.get('/code-occurrences/:id', requireCapability('findings.read'), async (req, res) => {
    try {
      const organizationId = req.organizationId;
      const userId = req.user?.id;
      if (!organizationId || !userId || !req.orgRole) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Organization context is required',
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Code occurrence id must be a valid UUID',
        });
      }
      await deps.accessControl.enforceCodeReviewAccess({ userId, organizationId });
      const detail = await detailReader.readCodeOccurrence({
        organizationId,
        occurrenceId: req.params.id,
      });
      if (!detail) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Code occurrence not found',
        });
      }
      return res.json(detail);
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[risks] Failed to load code occurrence detail');
      return sendApiError(res, {
        code: appError.code,
        message: appError.message,
        status: appError.httpStatus,
      });
    }
  });

  router.get('/:id', requireCapability('findings.read'), async (req, res) => {
    try {
      const organizationId = req.organizationId;
      const userId = req.user?.id;
      if (!organizationId || !userId || !req.orgRole) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Organization context is required',
        });
      }
      if (!UUID_RE.test(req.params.id)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Risk id must be a valid UUID',
        });
      }
      const subscription = await deps.accessControl.resolveOrganizationSubscription({
        userId,
        organizationId,
      });
      const detail = await detailReader.read({
        organizationId,
        riskId: req.params.id,
        includeCodeSource: subscription.plan.features?.accessCodeReview === true,
        includeExposureSource:
          subscription.plan.features?.accessThreatWatch === true
          && roleHasCapability(req.orgRole, 'threatwatch.read'),
      });
      if (!detail) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Risk not found',
        });
      }
      return res.json(detail);
    } catch (error) {
      const appError = toAppError(error);
      logger.error({ err: error }, '[risks] Failed to load Risk detail');
      return sendApiError(res, {
        code: appError.code,
        message: appError.message,
        status: appError.httpStatus,
      });
    }
  });

  return router;
}
