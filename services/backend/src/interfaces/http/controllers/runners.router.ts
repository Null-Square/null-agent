import { Router, type Response } from 'express';
import { createPlatformKernel } from '@/app/platform/kernel';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { db } from '@/db/client';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { RunnerService, type RunnerDetail, type RunnerSummary } from '@/domains/security-ops/runners/RunnerService';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  requirePrimaryOrgContext,
  requireRunnerOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import { AppError, ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

const toIso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : (value ?? null);

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const serializeRunner = (runner: RunnerSummary) => ({
  ...runner,
  lastHeartbeatAt: toIso(runner.lastHeartbeatAt),
  createdAt: toIso(runner.createdAt),
  updatedAt: toIso(runner.updatedAt),
});

const serializeRunnerDetail = (runner: RunnerDetail) => ({
  ...serializeRunner(runner),
  recentRuns: runner.recentRuns.map((run) => ({
    ...run,
    startedAt: toIso(run.startedAt),
    completedAt: toIso(run.completedAt),
    createdAt: toIso(run.createdAt),
    updatedAt: toIso(run.updatedAt),
  })),
});

const resolveRunnerApiUrl = (req: { protocol: string; get: (name: string) => string | undefined }): string => {
  const detectedOrigin = `${req.protocol}://${req.get('host') ?? 'localhost:3001'}`;
  const apiUrl = process.env.RUNNER_API_URL ?? process.env.API_URL ?? detectedOrigin;

  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'Runner API URL must be a valid absolute URL',
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'Runner API URL must use http or https protocol',
    );
  }

  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AppError(
      ERROR_CODES.VALIDATION_INVALID_FORMAT,
      'Runner API URL must use https in production',
    );
  }

  return parsed.toString().replace(/\/$/, '');
};

export function createRunnersRouter(): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const runnerService = new RunnerService(db);
  const auditService = new AuditService(db);
  const accessControl = createPlatformKernel().accessControl;

  router.use(authMiddleware);

  const sendClientError = (res: Response, err: AppError): void => {
    sendApiError(res, {
      code: err.code,
      message: err.message,
      status: err.httpStatus,
      context: err.context,
      userMessage: err.message,
    });
  };

  async function getOrgId(req: { user?: { id: string }; organizationId?: string }): Promise<string> {
    if (req.organizationId) {
      return req.organizationId;
    }

    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    req.organizationId = org.id;
    return org.id;
  }

  async function enforceRunnerAccess(req: { user?: { id: string }; organizationId?: string }): Promise<void> {
    const organizationId = await getOrgId(req);
    await accessControl.enforcePrivateRunnerAccess({
      userId: req.user?.id,
      organizationId,
    });
  }

  router.get('/', async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const { status, type } = req.query as Record<string, string | undefined>;
      const rows = await runnerService.listRunners(orgId, { status, type });
      res.json(rows.map(serializeRunner));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to list runners');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to list runners' });
    }
  });

  router.post('/', requirePrimaryOrgContext, requireCapability('runners.admin'), async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const { name, type, platform, architecture } = req.body as {
        name?: string;
        type?: string;
        platform?: string;
        architecture?: string;
      };

      if (!name?.trim()) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'name is required',
        });
      }
      if (type === 'cloud') {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Cloud runners are no longer user-configurable. External scopes execute directly.',
        });
      }

      const apiUrl = resolveRunnerApiUrl(req);

      const deployed = await runnerService.deployRunner(orgId, {
        name,
        type,
        platform,
        architecture,
        apiUrl,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'runner.deployed',
            resourceType: 'runner',
            resourceId: deployed.runner.id,
            changes: {
              after: {
                name: deployed.runner.name,
                type: deployed.runner.type,
                platform: deployed.runner.platform,
                architecture: deployed.runner.architecture,
                status: deployed.runner.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr }, '[runners] Failed to write audit log for deploy');
        }
      }

      res.status(201).json({
        ...deployed,
        runner: serializeRunner(deployed.runner),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to deploy runner');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to deploy runner' });
    }
  });

  router.get('/:id([0-9a-fA-F-]{36})', async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const detail = await runnerService.getRunner(orgId, req.params.id);
      res.json(serializeRunnerDetail(detail));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to get runner');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get runner detail' });
    }
  });

  router.delete(
    '/:id([0-9a-fA-F-]{36})',
    requireRunnerOrgContext(),
    requireCapability('runners.admin'),
    async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const existing = await runnerService.getRunner(orgId, req.params.id);
      await runnerService.deleteRunner(orgId, req.params.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'runner.deleted',
            resourceType: 'runner',
            resourceId: req.params.id,
            changes: {
              before: {
                name: existing.name,
                type: existing.type,
                status: existing.status,
                assignedScopes: existing.assignedScopes,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr }, '[runners] Failed to write audit log for delete');
        }
      }

      res.status(204).end();
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to delete runner');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to delete runner' });
    }
    },
  );

  router.put(
    '/:id([0-9a-fA-F-]{36})/scopes',
    requireRunnerOrgContext(),
    requireCapability('runners.manage'),
    async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const { scopeIds } = req.body as { scopeIds?: string[] };
      if (!Array.isArray(scopeIds)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'scopeIds must be an array',
        });
      }

      const before = await runnerService.getRunner(orgId, req.params.id);
      const detail = await runnerService.updateScopeAssignments(orgId, req.params.id, scopeIds);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'runner.scope_assignments_updated',
            resourceType: 'runner',
            resourceId: req.params.id,
            changes: {
              before: { scopeIds: before.assignedScopes },
              after: { scopeIds: detail.assignedScopes },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr }, '[runners] Failed to write audit log for scope assignment update');
        }
      }

      res.json(serializeRunnerDetail(detail));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to update scope assignments');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to update scope assignments' });
    }
    },
  );

  router.post(
    '/:id([0-9a-fA-F-]{36})/rotate-token',
    requireRunnerOrgContext(),
    requireCapability('runners.admin'),
    async (req, res) => {
    try {
      await enforceRunnerAccess(req);
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const apiUrl = resolveRunnerApiUrl(req);

      const token = await runnerService.rotateToken(orgId, req.params.id, apiUrl);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'runner.token_rotated',
            resourceType: 'runner',
            resourceId: req.params.id,
            changes: {
              after: { rotatedAt: new Date().toISOString() },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr }, '[runners] Failed to write audit log for token rotation');
        }
      }

      res.json(token);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runners] Failed to rotate runner token');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendClientError(res, err);
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to rotate runner token' });
    }
    },
  );

  return router;
}
