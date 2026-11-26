import { Router } from 'express';

import type { ResolvedConfig } from '@/config/configTypes';
import { securityOpsAuditService, securityOpsOrganizationService } from '@/domains/security-ops/audit/securityOpsServices';
import {
  buildOrgFallbackDocument,
  buildRoeFallbackDocument,
  hasMeaningfulOrgAnswers,
  hasMeaningfulRoeAnswers,
} from '@/domains/security-ops/context-setup/ContextSetupDocumentService';
import { securityOpsScopeService } from '@/domains/security-ops/scopes/securityOpsScopeService';
import { sendApiError, ERROR_CODES, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  requirePrimaryOrgContext,
  requireScopeOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import {
  OrgContextSetupGenerateBodySchema,
  ScopeContextSetupGenerateBodySchema,
} from './context-setup.schemas';

const orgService = securityOpsOrganizationService;
const scopeService = securityOpsScopeService;
const auditService = securityOpsAuditService;

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const writeDocumentResponse = (
  res: {
    status: (code: number) => unknown;
    setHeader: (name: string, value: string) => void;
    write: (chunk: string) => void;
    end: () => void;
  },
  document: string,
): void => {
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write(`<<<DOCUMENT>>>\n${document}\n<<<END>>>`);
  res.end();
};

type ContextSetupRouterDeps = {
  config: ResolvedConfig;
};

export function createContextSetupRouter(_deps: ContextSetupRouterDeps): Router {
  const router = Router();

  router.use(authMiddleware);

  router.post('/org/generate', requirePrimaryOrgContext, requireCapability('organization.manage'), async (req, res) => {
    const parsed = OrgContextSetupGenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
        message: issue?.message ?? 'Invalid context setup payload',
      });
    }

    if (!hasMeaningfulOrgAnswers(parsed.data.answers)) {
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
        message: 'At least one meaningful answer is required.',
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not authenticated',
      });
    }

    try {
      const orgId = req.organizationId ?? (await orgService.getForUser(userId)).id;
      const document = buildOrgFallbackDocument(parsed.data.answers);
      writeDocumentResponse(res, document);

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: 'context_setup.org_document_compiled',
          resourceType: 'organization',
          resourceId: orgId,
          changes: { after: { source: 'answers' } },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.warn({ err: auditErr, userId, orgId }, '[context-setup] Failed to write org compile audit log');
      }
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, userId }, '[context-setup] Failed to compile organization context document');
      if (!res.headersSent) {
        return sendApiError(res, {
          code: err.code ?? ERROR_CODES.INTERNAL_UNEXPECTED,
          message: err.message || 'Failed to compile document',
          status: err.httpStatus,
        });
      }
      res.end();
    }
  });

  router.post('/scope/generate', requirePrimaryOrgContext, requireCapability('context.manage'), async (req, res) => {
    const parsed = ScopeContextSetupGenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
        message: issue?.message ?? 'Invalid context setup payload',
      });
    }

    if (!hasMeaningfulRoeAnswers(parsed.data.answers)) {
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
        message: 'At least one meaningful answer is required.',
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not authenticated',
      });
    }

    try {
      const orgId = req.organizationId ?? (await orgService.getForUser(userId)).id;
      const document = buildRoeFallbackDocument(parsed.data.answers);
      writeDocumentResponse(res, document);

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: 'context_setup.scope_roe_compiled_draft',
          resourceType: 'organization',
          resourceId: orgId,
          changes: { after: { source: 'answers' } },
          metadata: {
            ...buildAuditMetadata(req),
            scopeName: parsed.data.seed?.scopeName ?? null,
          },
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.warn({ err: auditErr, userId, orgId }, '[context-setup] Failed to write draft scope compile audit log');
      }
    } catch (error) {
      const err = toAppError(error);
      logger.error(
        { err, userId, scopeName: parsed.data.seed?.scopeName ?? null },
        '[context-setup] Failed to compile draft scope rules-of-engagement document',
      );
      if (!res.headersSent) {
        return sendApiError(res, {
          code: err.code ?? ERROR_CODES.INTERNAL_UNEXPECTED,
          message: err.message || 'Failed to compile document',
          status: err.httpStatus,
        });
      }
      res.end();
    }
  });

  router.post(
    '/scope/:id([0-9a-fA-F-]{36})/generate',
    requireScopeOrgContext(),
    requireCapability('context.manage'),
    async (req, res) => {
    const parsed = ScopeContextSetupGenerateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
        message: issue?.message ?? 'Invalid context setup payload',
      });
    }

    if (!hasMeaningfulRoeAnswers(parsed.data.answers)) {
      return sendApiError(res, {
        code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
        message: 'At least one meaningful answer is required.',
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
        message: 'Not authenticated',
      });
    }

    try {
      const orgId = req.organizationId ?? (await orgService.getForUser(userId)).id;
      const scope = await scopeService.getById(orgId, req.params.id);
      const document = buildRoeFallbackDocument(parsed.data.answers);
      writeDocumentResponse(res, document);

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: 'context_setup.scope_roe_compiled',
          resourceType: 'scope',
          resourceId: scope.scope.id,
          changes: { after: { source: 'answers' } },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.warn({ err: auditErr, userId, scopeId: scope.scope.id }, '[context-setup] Failed to write scope compile audit log');
      }
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, userId, scopeId: req.params.id }, '[context-setup] Failed to compile scope rules-of-engagement document');
      if (!res.headersSent) {
        return sendApiError(res, {
          code: err.code ?? ERROR_CODES.INTERNAL_UNEXPECTED,
          message: err.message || 'Failed to compile document',
          status: err.httpStatus,
        });
      }
      res.end();
    }
    },
  );

  return router;
}
