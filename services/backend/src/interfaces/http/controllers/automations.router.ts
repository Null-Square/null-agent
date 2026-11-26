import { Router } from 'express';

import { db } from '@/db/client';
import { createAgentRepositories, type AgentRepositories } from '@/app/services/agent/agentRepositories';
import { createSubscriptionPort, createModelConfigPort } from '@/app/adapters/portFactories';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import type { AgentApiServices } from '@/app/services/agent/types';
import type { SubscriptionPort, ModelConfigPort } from '@/domains/agent-brain/ports';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import {
  RunService,
  type RunServiceSkillContextPort,
} from '@/domains/security-ops/runs/RunService';
import { StartRunService } from '@/domains/security-ops/runs/StartRunService';
import { WorkspaceProjectionService } from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { createAutomationRunExecutor } from '@/domains/security-ops/automations/buildAutomationRunExecutor';
import { securityOpsRunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import {
  requireAutomationOrgContext,
  requirePrimaryOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import { AppError, ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { normalizeModelCategory, type ModelCategory } from '@null-ai/contracts';
import type { ComplianceFrameworkKey } from '@null-ai/contracts';

type AutomationsRouterDeps = {
  services?: AgentApiServices;
  repositories?: AgentRepositories;
  sessionRepository?: AgentRepositories['sessionRepository'];
  policyRepository?: AgentRepositories['policyRepository'];
  accessControl?: PlatformKernel['accessControl'];
  subscriptionPort?: SubscriptionPort;
  modelConfigPort?: ModelConfigPort;
  kernel?: PlatformKernel;
  skillContextService?: RunServiceSkillContextPort;
  appRole?: string;
  enableWorkers?: boolean;
};

const toIso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : (value ?? null);

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const UUID_V4ISH_PATTERN = /^[0-9a-fA-F-]{36}$/;

const parseModelIdInput = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelId must be a valid UUID');
  }

  const normalized = value.trim();
  if (!normalized) return null;
  if (!UUID_V4ISH_PATTERN.test(normalized)) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelId must be a valid UUID');
  }
  return normalized;
};

const parseModelCategoryInput = (value: unknown): ModelCategory | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelCategory must be one of low, medium, high, extra_high');
  }

  const normalized = normalizeModelCategory(value);
  if (!normalized) {
    throw new AppError(ERROR_CODES.VALIDATION_INVALID_FORMAT, 'modelCategory must be one of low, medium, high, extra_high');
  }
  return normalized;
};

export function createAutomationsRouter(deps: AutomationsRouterDeps = {}): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const scopeService = new ScopeService(db);
  const runnerService = new RunnerService(db);
  const auditService = new AuditService(db);
  const kernel = deps.kernel ?? createPlatformKernel();
  const repositories = deps.repositories ?? createAgentRepositories();
  const sessionRepository = deps.sessionRepository ?? repositories.sessionRepository;
  const skillContextService = deps.skillContextService ?? securityOpsRunSkillContextService;
  const runService = new RunService(db, orgService, scopeService, {
    sessionStatusPort: sessionRepository,
    skillContextService,
  });
  const workspaceProjectionService = new WorkspaceProjectionService(db);
  const accessControl = deps.accessControl ?? kernel.accessControl;
  const subscriptionPort = deps.subscriptionPort ?? createSubscriptionPort(accessControl);
  const modelConfigPort = deps.modelConfigPort ?? createModelConfigPort();

  const sessionService = deps.services
    ? new SessionService(
        deps.services.sessionStore,
        deps.services.sandboxProfileRegistry,
        deps.services.ports,
        deps.services.agentEngine,
        subscriptionPort,
        deps.services.policyResolver,
        modelConfigPort,
        deps.services.traceRecorder,
        sessionRepository,
        deps.services.policyFacade,
      )
    : undefined;
  const startRunService =
    sessionService && deps.services
      ? new StartRunService({
          runService,
          scopeService,
          runnerService,
          sessionService,
          agentServices: deps.services,
          sessionRepository,
          scopeAccessMaterialService: new ScopeAccessMaterialService(db),
          workspaceProjectionService,
        })
      : undefined;

  const workersEnabled = deps.enableWorkers ?? true;
  const appRole = deps.appRole ?? 'api';
  const allowExecution = Boolean(sessionService && deps.services && (workersEnabled || appRole === 'worker'));

  const runExecutor =
    startRunService
      ? createAutomationRunExecutor({
          startRunService,
          scopeService,
          runService,
          accessControl,
          allowExecution,
        })
      : undefined;

  const automationService = new AutomationService({
    db,
    runExecutor,
  });

  router.use(authMiddleware);

  const serializeAutomation = (row: Awaited<ReturnType<AutomationService['listAutomations']>>[number]) => ({
    ...row,
    lastRunAt: toIso(row.lastRunAt),
    nextRunAt: toIso(row.nextRunAt),
    deferredAt: toIso(row.deferredAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  });

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

  async function resolveActiveModelId(modelIdInput: unknown): Promise<string | null | undefined> {
    const parsedModelId = parseModelIdInput(modelIdInput);
    if (parsedModelId === undefined || parsedModelId === null) {
      return parsedModelId;
    }

    const model = await modelConfigPort.getModel(parsedModelId);
    if (!model || model.isActive === false) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model not found', {
        httpStatus: 404,
      });
    }

    return parsedModelId;
  }

  async function resolveActiveModelCategory(modelCategoryInput: unknown): Promise<ModelCategory | null | undefined> {
    const parsedCategory = parseModelCategoryInput(modelCategoryInput);
    if (parsedCategory === undefined || parsedCategory === null) {
      return parsedCategory;
    }

    const models = await modelConfigPort.listModelsForCategory(parsedCategory);
    if (models.length === 0) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model category not found', {
        httpStatus: 404,
      });
    }

    return parsedCategory;
  }

  async function resolveModelCategoryForGate(
    modelId: string | null | undefined,
    modelCategory: ModelCategory | null | undefined,
  ): Promise<ModelCategory | null> {
    if (modelCategory) {
      return modelCategory;
    }
    if (!modelId) {
      return null;
    }
    const model = await modelConfigPort.getModel(modelId);
    if (!model || model.isActive === false) {
      throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Model not found', {
        httpStatus: 404,
      });
    }
    return model.selectionCategory ?? null;
  }

  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await accessControl.enforceAutomationFeature({ userId: req.user?.id, organizationId: orgId });
      const { scopeId, isActive, triggerType } = req.query as Record<string, string | undefined>;
      const rows = await automationService.listAutomations(orgId, {
        scopeId,
        ...(isActive !== undefined ? { isActive: isActive === 'true' } : {}),
        triggerType: triggerType as 'scheduled' | 'continuous' | 'event' | undefined,
      });
      res.json(rows.map(serializeAutomation));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to list automations');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to list automations' });
    }
  });

  router.post('/', requirePrimaryOrgContext, requireCapability('automations.manage'), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, { code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, message: 'Not authenticated' });
      }
      const orgId = await getOrgId(req);
      const body = req.body as {
        name?: string;
        description?: string;
        scopeId?: string;
        modelId?: string | null;
        modelCategory?: string | null;
        workflowDiscipline?: 'pentest' | 'compliance';
        complianceFrameworkKey?: ComplianceFrameworkKey | null;
        executionTarget?: 'cloud' | 'scope_runner';
        goal?: string;
        triggerType?: 'scheduled' | 'continuous' | 'event';
        triggerConfig?: unknown;
        isActive?: boolean;
      };

      if (!body.name || !body.scopeId || !body.goal || !body.triggerType || body.triggerConfig === undefined) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'name, scopeId, goal, triggerType, and triggerConfig are required',
        });
      }

      const existingAutomationCount = await automationService.countAutomations(orgId);
      await accessControl.enforceAutomationCreation({
        userId,
        organizationId: orgId,
        existingAutomationCount,
      });
      if (body.workflowDiscipline === 'compliance') {
        await accessControl.enforceComplianceAccess({ userId, organizationId: orgId });
      }
      if (body.executionTarget === 'scope_runner') {
        await accessControl.enforcePrivateRunnerAccess({ userId, organizationId: orgId });
      }
      const modelId = await resolveActiveModelId(body.modelId);
      const modelCategory = await resolveActiveModelCategory(body.modelCategory);
      await accessControl.enforceModelCategoryAccess({
        userId,
        organizationId: orgId,
        requestedModelCategory: await resolveModelCategoryForGate(modelId, modelCategory),
      });

      const created = await automationService.createAutomation(orgId, userId, {
        name: body.name,
        description: body.description,
        scopeId: body.scopeId,
        modelId,
        modelCategory,
        workflowDiscipline: body.workflowDiscipline,
        complianceFrameworkKey: body.complianceFrameworkKey,
        executionTarget: body.executionTarget,
        goal: body.goal,
        triggerType: body.triggerType,
        triggerConfig: body.triggerConfig,
        isActive: body.isActive,
      });

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: 'automation.created',
          resourceType: 'automation',
          resourceId: created.id,
          changes: {
            after: {
              name: created.name,
              scopeId: created.scopeId,
              modelId: created.modelId,
              modelCategory: created.modelCategory,
              workflowDiscipline: created.workflowDiscipline,
              complianceFrameworkKey: created.complianceFrameworkKey,
              executionTarget: created.executionTarget,
              goal: created.goal,
              triggerType: created.triggerType,
              triggerConfig: created.triggerConfig,
              isActive: created.isActive,
            },
          },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.error({ err: auditErr, automationId: created.id }, '[automations] Failed to write audit log for create');
      }

      res.status(201).json(serializeAutomation(created));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to create automation');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to create automation' });
    }
  });

  router.get('/:id([0-9a-fA-F-]{36})', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await accessControl.enforceAutomationFeature({ userId: req.user?.id, organizationId: orgId });
      const detail = await automationService.getAutomation(orgId, req.params.id);
      res.json({
        ...serializeAutomation(detail),
        runs: detail.runs.map((run) => ({
          ...run,
          triggeredAt: toIso(run.triggeredAt),
          runCreatedAt: toIso(run.runCreatedAt),
        })),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to get automation detail');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to get automation' });
    }
  });

  router.put(
    '/:id([0-9a-fA-F-]{36})',
    requireAutomationOrgContext(),
    requireCapability('automations.manage'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      await accessControl.enforceAutomationFeature({ userId: actorId ?? undefined, organizationId: orgId });
      const body = req.body as Partial<{
        name: string;
        description: string;
        triggerType: 'scheduled' | 'continuous' | 'event';
        triggerConfig: unknown;
        modelId: string | null;
        modelCategory: string | null;
        workflowDiscipline: 'pentest' | 'compliance';
        complianceFrameworkKey: ComplianceFrameworkKey | null;
        executionTarget: 'cloud' | 'scope_runner';
        goal: string;
        scopeId: string;
        isActive: boolean;
      }>;
      const before = await automationService.getAutomation(orgId, req.params.id);
      if (
        body.workflowDiscipline === 'compliance' ||
        (body.workflowDiscipline === undefined && before.workflowDiscipline === 'compliance')
      ) {
        await accessControl.enforceComplianceAccess({ userId: actorId ?? undefined, organizationId: orgId });
      }
      if (body.executionTarget === 'scope_runner') {
        await accessControl.enforcePrivateRunnerAccess({ userId: actorId ?? undefined, organizationId: orgId });
      }
      const modelId =
        body.modelId !== undefined
          ? await resolveActiveModelId(body.modelId)
          : body.modelId;
      const modelCategory =
        body.modelCategory !== undefined
          ? await resolveActiveModelCategory(body.modelCategory)
          : body.modelCategory;
      if (body.modelId !== undefined || body.modelCategory !== undefined) {
        await accessControl.enforceModelCategoryAccess({
          userId: actorId ?? undefined,
          organizationId: orgId,
          requestedModelCategory: await resolveModelCategoryForGate(modelId ?? before.modelId, modelCategory ?? before.modelCategory),
        });
      }
      const { modelId: _rawModelId, modelCategory: _rawModelCategory, ...automationPatch } = body;
      const updated = await automationService.updateAutomation(orgId, req.params.id, {
        ...automationPatch,
        ...(body.modelId !== undefined ? { modelId } : {}),
        ...(body.modelCategory !== undefined ? { modelCategory } : {}),
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'automation.updated',
            resourceType: 'automation',
            resourceId: updated.id,
            changes: {
              before: {
                name: before.name,
                description: before.description,
                scopeId: before.scopeId,
                modelId: before.modelId,
                modelCategory: before.modelCategory,
                workflowDiscipline: before.workflowDiscipline,
                complianceFrameworkKey: before.complianceFrameworkKey,
                executionTarget: before.executionTarget,
                goal: before.goal,
                triggerType: before.triggerType,
                triggerConfig: before.triggerConfig,
                isActive: before.isActive,
              },
              after: {
                name: updated.name,
                description: updated.description,
                scopeId: updated.scopeId,
                modelId: updated.modelId,
                modelCategory: updated.modelCategory,
                workflowDiscipline: updated.workflowDiscipline,
                complianceFrameworkKey: updated.complianceFrameworkKey,
                executionTarget: updated.executionTarget,
                goal: updated.goal,
                triggerType: updated.triggerType,
                triggerConfig: updated.triggerConfig,
                isActive: updated.isActive,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, automationId: updated.id }, '[automations] Failed to write audit log for update');
        }
      }

      res.json(serializeAutomation(updated));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to update automation');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to update automation' });
    }
    },
  );

  router.delete(
    '/:id([0-9a-fA-F-]{36})',
    requireAutomationOrgContext(),
    requireCapability('automations.delete'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      await accessControl.enforceAutomationFeature({ userId: actorId ?? undefined, organizationId: orgId });
      const before = await automationService.getAutomation(orgId, req.params.id);
      await automationService.deleteAutomation(orgId, req.params.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'automation.deleted',
            resourceType: 'automation',
            resourceId: req.params.id,
            changes: {
              before: {
                name: before.name,
                scopeId: before.scopeId,
                modelId: before.modelId,
                modelCategory: before.modelCategory,
                workflowDiscipline: before.workflowDiscipline,
                complianceFrameworkKey: before.complianceFrameworkKey,
                executionTarget: before.executionTarget,
                goal: before.goal,
                triggerType: before.triggerType,
                triggerConfig: before.triggerConfig,
                isActive: before.isActive,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, automationId: req.params.id }, '[automations] Failed to write audit log for delete');
        }
      }

      res.json({ success: true });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to delete automation');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to delete automation' });
    }
    },
  );

  router.put(
    '/:id([0-9a-fA-F-]{36})/toggle',
    requireAutomationOrgContext(),
    requireCapability('automations.manage'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      await accessControl.enforceAutomationFeature({ userId: actorId ?? undefined, organizationId: orgId });
      const before = await automationService.getAutomation(orgId, req.params.id);
      const updated = await automationService.toggleActive(orgId, req.params.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'automation.toggled',
            resourceType: 'automation',
            resourceId: updated.id,
            changes: {
              before: { isActive: before.isActive },
              after: { isActive: updated.isActive },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, automationId: updated.id }, '[automations] Failed to write audit log for toggle');
        }
      }

      res.json(serializeAutomation(updated));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to toggle automation');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to toggle automation' });
    }
    },
  );

  router.post(
    '/:id([0-9a-fA-F-]{36})/run-now',
    requireAutomationOrgContext(),
    requireCapability('automations.manage'),
    async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      await accessControl.enforceAutomationFeature({ userId: actorId ?? undefined, organizationId: orgId });
      const result = await automationService.triggerNow(orgId, req.params.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'automation.run_now_triggered',
            resourceType: 'automation',
            resourceId: req.params.id,
            changes: {
              after: {
                runId: result.run.id,
                sessionId: result.sessionId,
                runStatus: result.run.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, automationId: req.params.id }, '[automations] Failed to write audit log for run-now');
        }
      }

      res.status(201).json({
        run: {
          ...result.run,
          createdAt: toIso(result.run.createdAt),
        },
        sessionId: result.sessionId,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[automations] Failed to run automation now');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
          context: err.context,
          userMessage: err.message,
        });
        return;
      }
      sendApiError(res, { code: ERROR_CODES.INTERNAL_UNEXPECTED, message: 'Failed to trigger automation' });
    }
    },
  );

  return router;
}
