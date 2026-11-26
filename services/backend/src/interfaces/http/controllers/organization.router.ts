import { Router } from 'express';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import { requirePrimaryOrgContext } from '@/interfaces/http/middleware/orgContext';
import { db } from '@/db/client';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { sendApiError, ERROR_CODES, toAppError } from '@/shared/errors';
import type { ErrorCodeValue } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { authorizationService } from '@/shared/auth/authorization/AuthorizationService';

const orgService = new OrganizationService(db);
const auditService = new AuditService(db);
/* One short paragraph about the company, not a document. It was 4,000
   characters and a six-field wizard that composed a markdown file; everything
   that wizard asked beyond "what does this company do" — sensitive data, hard
   no's, escalation — is per-scope rules of engagement and lives there. */
const MAX_ORGANIZATION_BRIEF_LENGTH = 500;


const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const normalizeOptionalDocument = (
  raw: unknown,
  fieldName: string,
  maxLength: number,
): { valid: true; value: string | null | undefined } | { valid: false; code: ErrorCodeValue; message: string } => {
  if (raw === undefined) {
    return { valid: true, value: undefined };
  }
  if (raw === null) {
    return { valid: true, value: null };
  }
  if (typeof raw !== 'string') {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
      message: `${fieldName} must be a string or null`,
    };
  }

  const normalized = raw.trim();
  if (normalized.length > maxLength) {
    return {
      valid: false,
      code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
      message: `${fieldName} must be ${maxLength} characters or fewer`,
    };
  }

  return { valid: true, value: normalized.length > 0 ? normalized : null };
};

export function createOrganizationRouter(): Router {
  const router = Router();

  router.use(authMiddleware);

  router.get('/me/permissions', requirePrimaryOrgContext, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId || !req.organizationId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }
      const access = await authorizationService.organizationAccess(userId, req.organizationId);
      res.json({
        organizationId: req.organizationId,
        role: req.orgRole ?? null,
        roles: access.roles,
        capabilities: access.capabilities,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[organization] Failed to get permission snapshot');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get organization permissions',
      });
    }
  });

  // GET /api/app/organization — current user's org
  router.get('/', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, { code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, message: 'Not authenticated' });
      }
      const org = await orgService.getForUser(userId);
      res.json(org);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[organization] Failed to get org');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get organization' });
    }
  });

  // GET /api/app/organization/members — list org members for finding assignment
  router.get('/members', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }
      const org = await orgService.getForUser(userId);
      const members = await orgService.listMembers(org.id);
      res.json(members);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[organization] Failed to list members');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to list organization members',
      });
    }
  });

  // PUT /api/app/organization — update org profile
  router.put('/', requirePrimaryOrgContext, requireCapability('organization.manage'), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, { code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, message: 'Not authenticated' });
      }

      // First get the user's org to check ownership
      const org = await orgService.getForUser(userId);

      const {
        name,
        operationalContext,
      } = req.body;

      const normalizedOperationalContext = normalizeOptionalDocument(
        operationalContext,
        'operationalContext',
        MAX_ORGANIZATION_BRIEF_LENGTH,
      );
      if (!normalizedOperationalContext.valid) {
        return sendApiError(res, {
          code: normalizedOperationalContext.code,
          message: normalizedOperationalContext.message,
        });
      }
      const updated = await orgService.update(org.id, {
        ...(name !== undefined && { name }),
        ...(normalizedOperationalContext.value !== undefined && { operationalContext: normalizedOperationalContext.value }),
      });


      try {
        await auditService.log({
          organizationId: org.id,
          actorId: userId,
          actorType: 'user',
          action: 'organization.profile_updated',
          resourceType: 'organization',
          resourceId: org.id,
          changes: {
            before: {
              name: org.name,
              operationalContext: org.operationalContext,
            },
            after: {
              name: updated.name,
              operationalContext: updated.operationalContext,
            },
          },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.error({ err: auditErr }, '[organization] Failed to write audit log for org profile update');
      }

      res.json(updated);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[organization] Failed to update org');
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to update organization' });
    }
  });

  return router;
}
