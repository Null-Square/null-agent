import { Router } from 'express';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { db } from '@/db/client';
import { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { TimelineService } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService, type ScopeDetail } from '@/domains/security-ops/scopes/ScopeService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { RunActivityService } from '@/domains/security-ops/runs/RunActivityService';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import { ValidationQueueRepository } from '@/domains/security-ops/runs/ValidationQueueRepository';
import { WorkspaceProxyCaptureSource } from '@/domains/security-ops/runs/WorkspaceProxyCaptureSource';
import { projectRunPhaseRows } from '@/domains/security-ops/runs/runPhaseProjection';
import { ComplianceReadinessService } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import {
  FRAMEWORK_REGISTRY,
  type ComplianceFrameworkKey,
  type ControlDefinition,
} from '@/domains/security-ops/compliance/frameworks';
import {
  RunService,
  isRunAwaitingPlanApproval,
  type SessionRuntimeStatusPort,
  type RunServiceSkillContextPort,
} from '@/domains/security-ops/runs/RunService';
import {
  CODE_REVIEW_PLANNER_TOOL_POLICY,
  COMPLIANCE_PLANNER_TOOL_POLICY,
  DEFAULT_PLANNER_TOOL_POLICY,
  StartRunService,
} from '@/domains/security-ops/runs/StartRunService';
import { WorkspaceProjectionService } from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { securityOpsRunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { createAgentRepositories, type AgentRepositories } from '@/app/services/agent/agentRepositories';
import { createSubscriptionPort, createModelConfigPort } from '@/app/adapters/portFactories';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import type { AgentApiServices } from '@/app/services/agent/types';
import type { SubscriptionPort, ModelConfigPort } from '@/domains/agent-brain/ports';
import { AppError, sendApiError, ERROR_CODES } from '@/shared/errors';
import { toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { ModelCategory } from '@null-ai/contracts';
import type { CodeReviewContext } from '@/db/schema';
import type { S3StorageService } from '@/shared/storage/S3StorageService';
import type { ResolvedConfig } from '@/config/configTypes';
import { schedulingClassForPlan } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';
import { CodeReviewFindingService } from '@/domains/security-ops/code-review/CodeReviewFindingService';
import { CodeSourceService } from '@/domains/security-ops/code-sources/CodeSourceService';
import {
  buildCodeReviewManifestHash,
  filterCodeReviewManifestFiles,
} from '@/domains/security-ops/runs/codeReviewRunContext';
import {
  DEFAULT_RUN_LIST_LIMIT,
  MAX_RUN_LIST_LIMIT,
  ComplianceAssessmentCreateBodySchema,
  ComplianceReportCreateBodySchema,
  CodeReviewCreateBodySchema,
  CodeReviewFixRequestBodySchema,
  PlanFeedbackBodySchema,
  RunApproveBodySchema,
  RunCreateBodySchema,
  RunsListQuerySchema,
} from './runs.schemas';
import { customerRunnerId, customerRunnerName, schedulingProjection, withRunUiFlags } from './runPublicProjection';

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const isComplianceAgentWorkflowEnabled = (): boolean => {
  const value = process.env.COMPLIANCE_AGENT_WORKFLOW_ENABLED;
  if (value === undefined) {
    return true;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const PCI_DSS_CDE_PATTERN =
  /\b(?:cde|cardholder\s+data\s+environment|cardholder\s+data|payment\s+page|checkout|pan|primary\s+account\s+number|sensitive\s+authentication\s+data|sad)\b/iu;
const PCI_DSS_SAQ_PATTERN =
  /\b(?:saq|self[-\s]+assessment\s+questionnaire|merchant\s+level|service\s+provider|a-ep|b-ip|c-vt|d-merchant|d-service\s+provider|p2pe)\b/iu;

const summarizePciDssProfileStatus = (scopeDetail: ScopeDetail, organizationContext?: string | null) => {
  const sourceText = [
    organizationContext,
    scopeDetail.scope.name,
    scopeDetail.scope.mission,
    ...(scopeDetail.targets ?? []).map((target) => `${target.type}:${target.value}`),
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
  const cdeDeclared = PCI_DSS_CDE_PATTERN.test(sourceText);
  const saqDeclared = PCI_DSS_SAQ_PATTERN.test(sourceText);
  const missing = [
    ...(!cdeDeclared ? ['CDE boundary/profile'] : []),
    ...(!saqDeclared ? ['SAQ type or merchant/service-provider profile'] : []),
  ];

  return {
    cdeDeclared,
    saqDeclared,
    hasProfileContext: cdeDeclared && saqDeclared,
    missing,
    summary:
      missing.length === 0
        ? 'CDE and SAQ profile context appears declared in scope context.'
        : `Missing PCI DSS profile context: ${missing.join('; ')}.`,
  };
};

const sendRetiredComplianceAssessmentRoute = (res: Parameters<typeof sendApiError>[0]) =>
  sendApiError(res, {
    code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
    status: 410,
    message: 'This compliance assessment path is retired. Use POST /api/app/runs/compliance-assessments.',
    userMessage: 'This compliance assessment path is retired. Use POST /api/app/runs/compliance-assessments.',
  });

const evidenceReviewObligationId = (frameworkKey: ComplianceFrameworkKey, controlId: string): string =>
  `evidence-review:${frameworkKey}:${controlId.toLowerCase()}`;

const summarizeControlAssessmentObligations = (frameworkKey: ComplianceFrameworkKey, controls: ControlDefinition[]) =>
  controls.map((control) => ({
    controlId: control.id,
    title: control.title,
    supportLevel: control.supportLevel,
    implementationSpec: control.implementationSpec ?? null,
    pciDssRequirement: control.pciDssRequirement ?? null,
    pciDssGoal: control.pciDssGoal ?? null,
    pciDssApproach: control.pciDssApproach ?? null,
    pciDssSaqTypes: control.pciDssSaqTypes ?? null,
    pciDssCdeScope: control.pciDssCdeScope ?? null,
    pciDssAccountData: control.pciDssAccountData ?? null,
    id: control.proofObligation?.id ?? evidenceReviewObligationId(frameworkKey, control.id),
    statement:
      control.proofObligation?.statement ??
      `Review mapped user-uploaded or integration evidence for ${control.id}: ${control.title}. If no sufficient evidence is available, create a specific record_control_request for the missing evidence, access, context, or remediation.`,
    requiredEvidence: control.proofObligation?.requiredEvidence ??
      control.evidenceExamples ?? [control.positiveEvidenceLabel],
    missingGap: control.missingGap,
    acceptedMethods: control.proofObligation?.acceptedMethods ?? [
      'agent-reviewed user evidence',
      'agent-reviewed integration evidence',
    ],
    assessmentSkillSlugs:
      control.assessmentSkillSlugs ??
      (control.testSkillSlugs ?? [])
        .filter((slug) => slug.startsWith('compliance-'))
        .concat(control.proofObligation ? [] : ['compliance-evidence-review'])
        .filter((slug, index, values) => values.indexOf(slug) === index),
  }));

const SUPPORTED_COMPLIANCE_ASSESSMENT_PACK = 'agent_control_workspace_v1';

const getPlannerAssessmentControls = (framework: ComplianceFrameworkKey) =>
  (FRAMEWORK_REGISTRY[framework]?.controls ?? []).filter((control) => control.supportLevel !== 'out_of_selected_scope');

const getExplicitAssessmentControls = (framework: ComplianceFrameworkKey) =>
  (FRAMEWORK_REGISTRY[framework]?.controls ?? []).filter((control) => control.supportLevel !== 'out_of_selected_scope');

const toRuntimeDate = (value: Date | number | string | null | undefined): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const millis = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis) : null;
};

const createRunSessionStatusPort = (
  sessionRepository: AgentRepositories['sessionRepository'],
  sessionStore?: AgentApiServices['sessionStore'],
): SessionRuntimeStatusPort => ({
  async getRuntimeSnapshot(sessionId) {
    const durable = await sessionRepository.getRuntimeSnapshot(sessionId);
    const liveSession = sessionStore?.get(sessionId);
    if (!durable && !liveSession) {
      return null;
    }

    const liveProcessing =
      typeof liveSession?.stateMachine?.isProcessing === 'function'
        ? liveSession.stateMachine.isProcessing()
        : undefined;

    return {
      completed: Boolean(durable?.completed ?? liveSession?.completed ?? false),
      blockedReason: durable?.blockedReason ?? liveSession?.blockedReason ?? null,
      hasPendingApproval: Boolean(durable?.hasPendingApproval || liveSession?.pendingApproval),
      isProcessing: liveProcessing,
      lastActiveAt: durable?.lastActiveAt ?? toRuntimeDate(liveSession?.lastActive),
    };
  },
  findById:
    typeof sessionRepository.findById === 'function' ? (sessionId) => sessionRepository.findById(sessionId) : undefined,
  listIdsByRunId:
    typeof sessionRepository.listIdsByRunId === 'function'
      ? (runId) => sessionRepository.listIdsByRunId(runId)
      : undefined,
});

const RUN_STATUS_FILTERS: Record<string, string[]> = {
  queued: ['queued'],
  running: ['running'],
  paused: [
    'credits_exhausted',
    'user_paused',
    'awaiting_user',
    'awaiting_approval',
    'runner_unavailable',
    'system_paused',
  ],
  completed: ['completed'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

type RunsRouterDeps = {
  services?: AgentApiServices;
  repositories?: AgentRepositories;
  sessionRepository?: AgentRepositories['sessionRepository'];
  policyRepository?: AgentRepositories['policyRepository'];
  accessControl?: PlatformKernel['accessControl'];
  subscriptionPort?: SubscriptionPort;
  modelConfigPort?: ModelConfigPort;
  kernel?: PlatformKernel;
  skillContextService?: RunServiceSkillContextPort;
  runActivityService?: RunActivityService;
  runPhaseRepository?: Pick<RunPhaseRepository, 'listByRunId'>;
  workspaceProjectionService?: WorkspaceProjectionService;
  traceRoot?: string;
  s3TracesClient?: S3StorageService;
  traceIndexRepository?: TraceIndexRepository;
  appRole?: string;
  enableWorkers?: boolean;
  config?: ResolvedConfig;
  /** The scope's code source a Code Review pins; defaults to the local folder or clone. */
  codeSourceService?: Pick<CodeSourceService, 'getForScope' | 'resolveCodeReviewRepositorySnapshot'>;
};

export function createRunsRouter(deps: RunsRouterDeps = {}): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const scopeService = new ScopeService(db);
  const runnerService = new RunnerService(db);
  const auditService = new AuditService(db);
  const kernel = deps.kernel ?? createPlatformKernel();
  const repositories = deps.repositories ?? createAgentRepositories();
  const sessionRepository = deps.sessionRepository ?? repositories.sessionRepository;
  const skillContextService = deps.skillContextService ?? securityOpsRunSkillContextService;
  const runPhaseRepository = deps.runPhaseRepository ?? new RunPhaseRepository(db);
  const complianceReadinessService = new ComplianceReadinessService(db);
  const codeReviewFindingService = new CodeReviewFindingService(db);
  const codeSourceService = deps.codeSourceService ?? new CodeSourceService(db);
  const traceIndexRepository =
    deps.traceIndexRepository ?? (deps.s3TracesClient ? new TraceIndexRepository() : undefined);
  const runService = new RunService(db, orgService, scopeService, {
    sessionStatusPort: createRunSessionStatusPort(sessionRepository, deps.services?.sessionStore),
    skillContextService,
  });
  const workspaceProjectionService = deps.workspaceProjectionService ?? new WorkspaceProjectionService(db);
  const accessControl = deps.accessControl ?? kernel.accessControl;
  const subscriptionPort = deps.subscriptionPort ?? createSubscriptionPort(accessControl);
  const modelConfigPort = deps.modelConfigPort ?? createModelConfigPort();
  const timelineService = new TimelineService({
    traceRoot: deps.traceRoot ?? 'storage/object-store/traces',
    s3Client: deps.s3TracesClient,
    traceIndexRepository,
  });
  const runActivityService =
    deps.runActivityService ??
    new RunActivityService({
      timelineService,
      sessionResolver: sessionRepository,
      phaseSource: runPhaseRepository,
      validationQueueSource: new ValidationQueueRepository(db),
      proxyCaptureSource: new WorkspaceProxyCaptureSource(db),
    });

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

  router.use(authMiddleware);

  async function getOrgId(req: { user?: { id: string } }): Promise<string> {
    const userId = req.user?.id;
    if (!userId) throw new Error('Not authenticated');
    const org = await orgService.getForUser(userId);
    return org.id;
  }

  async function ensureRunOwned(req: { user?: { id: string } }, runId: string): Promise<string> {
    const orgId = await getOrgId(req);
    await runService.getById(orgId, runId);
    return orgId;
  }

  async function resolveRequestedModelCategory(
    modelId?: string,
    modelCategory?: ModelCategory,
  ): Promise<ModelCategory | null> {
    if (modelCategory) {
      return modelCategory;
    }
    if (!modelId) {
      return null;
    }
    const model = await modelConfigPort.getModel(modelId);
    if (!model || model.isActive === false) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Selected model is no longer available', {
        httpStatus: 400,
      });
    }
    return model.selectionCategory ?? null;
  }

  // GET /api/app/runs — list runs (enriched with computed fields)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const parsedQuery = RunsListQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        const issue = parsedQuery.error.issues[0];
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: issue?.message ?? 'Invalid query parameters',
        });
      }
      const { scopeId, status, trigger, limit } = parsedQuery.data;
      const safeLimit = limit ? Math.min(Math.floor(Number(limit)), MAX_RUN_LIST_LIMIT) : DEFAULT_RUN_LIST_LIMIT;
      const statusFilters = status && status !== 'all' ? (RUN_STATUS_FILTERS[status] ?? [status]) : undefined;

      const list = await runService.list(orgId, {
        scopeId,
        statuses: statusFilters,
        trigger: trigger === 'all' ? undefined : trigger,
        limit: safeLimit,
      });
      const runnerNameById = new Map(
        (await runnerService.listRunners(orgId)).map((runner) => [runner.id, runner.name]),
      );

      // Batch-fetch scope names for all unique scopeIds
      const scopeIds = [...new Set(list.map((r) => r.scopeId))];
      const scopeNames = new Map<string, string>();
      for (const sid of scopeIds) {
        try {
          const detail = await scopeService.getById(orgId, sid);
          scopeNames.set(sid, detail.scope.name);
        } catch {
          scopeNames.set(sid, 'Unknown');
        }
      }

      const enriched = list.map((r) => ({
        ...withRunUiFlags(r),
        displayId: typeof r.displayId === 'number' ? `#r${r.displayId}` : `#r${r.id.slice(0, 4)}`,
        scopeName: scopeNames.get(r.scopeId) ?? 'Unknown',
        findingsDiscovered: r.findingsCount,
        inventoryChanges: `+${r.inventoryAdded}`,
        runnerId: customerRunnerId(r),
        runnerName: customerRunnerName(r, r.runnerId ? runnerNameById.get(r.runnerId) : null),
      }));

      res.json(enriched);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to list runs');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to list runs',
      });
    }
  });

  // POST /api/app/runs — start a new run
  router.post('/', async (req, res) => {
    try {
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
      }

      const workersEnabled = deps.enableWorkers ?? true;
      const appRole = deps.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is disabled on API-only nodes',
        });
      }

      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const userId = actorId ?? '';
      const parsedBody = RunCreateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        const issue = parsedBody.error.issues[0];
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: issue?.message ?? 'Invalid run payload',
        });
      }
      const {
        scopeId,
        goal: normalizedGoal,
        modelId,
        modelCategory,
        executionTarget = 'cloud',
        trigger = 'manual',
        vars,
      } = parsedBody.data;
      const requestedModelCategory = await resolveRequestedModelCategory(modelId, modelCategory);
      const activeRunCount = await runService.countPlanConcurrentRuns(orgId);
      const subscription = await accessControl.enforceRunCreation({
        userId: actorId ?? undefined,
        organizationId: orgId,
        activeRunCount,
        requestedModelCategory,
        deferConcurrencyToAdmission: startRunService.usesQueuedCloudAdmission(executionTarget),
      });
      if (executionTarget === 'scope_runner') {
        await accessControl.enforcePrivateRunnerAccess({
          userId: actorId ?? undefined,
          organizationId: orgId,
        });
      }
      await scopeService.getById(orgId, scopeId);
      const effectiveAutoApprove = true;

      const startResult = await startRunService.startPlannerRun({
        orgId,
        userId,
        scopeId,
        goal: normalizedGoal,
        modelId,
        modelCategory,
        executionTarget,
        trigger: trigger as 'manual' | 'scheduled' | 'event',
        vars,
        toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
        autoApproveOnPlanning: effectiveAutoApprove,
        maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
        schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      });

      if (startResult.idempotentReplay) {
        res.status(200).json({
          run: {
            ...withRunUiFlags(startResult.run),
            executionTarget: startResult.run.executionTarget,
            runnerId: customerRunnerId(startResult.run),
            runnerName: customerRunnerName(startResult.run, startResult.runnerName),
          },
          sessionId: startResult.sessionId,
          policySlug: startResult.policySlug,
          warnings: startResult.warnings,
          idempotentReplay: true,
          runner: startResult.run.executionTarget === 'cloud' ? null : startResult.runner,
          scheduling: schedulingProjection(startResult.run),
        });
        return;
      }

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.created',
            resourceType: 'run',
            resourceId: startResult.run.id,
            changes: {
              after: {
                scopeId,
                sessionId: startResult.sessionId,
                goal: normalizedGoal,
                modelId: modelId ?? null,
                modelCategory: modelCategory ?? null,
                executionTarget,
                trigger,
                runnerId: startResult.runner?.id ?? null,
                status: startResult.run.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, runId: startResult.run.id },
            '[runs] Failed to write audit log for run creation',
          );
        }
      }

      res.status(startResult.run.status === 'queued' ? 202 : 201).json({
        run: {
          ...withRunUiFlags(startResult.run),
          executionTarget: startResult.run.executionTarget,
          runnerId: customerRunnerId(startResult.run),
          runnerName: customerRunnerName(startResult.run, startResult.runnerName),
        },
        sessionId: startResult.sessionId,
        policySlug: startResult.policySlug,
        warnings: startResult.warnings,
        runner: startResult.run.executionTarget === 'cloud' ? null : startResult.runner,
        scheduling: schedulingProjection(startResult.run),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to create run');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to create run',
      });
    }
  });

  // POST /api/app/runs/code-reviews — start a standalone immutable review of the scope's code source
  router.post('/code-reviews', async (req, res) => {
    try {
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Code Review execution is not available on this node',
        });
      }
      const workersEnabled = deps.enableWorkers ?? true;
      const appRole = deps.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is disabled on API-only nodes',
        });
      }

      const actorId = req.user?.id ?? null;
      if (!actorId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }
      const orgId = await getOrgId(req);
      const parsedBody = CodeReviewCreateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid Code Review payload',
        });
      }
      const { scopeId, allowedPaths, excludedPaths, goal, modelId, modelCategory } = parsedBody.data;
      await scopeService.getById(orgId, scopeId);
      const codeSource = await codeSourceService.getForScope(orgId, scopeId);
      if (!codeSource) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'This scope has no code source. Point it at a folder or a public git URL first.',
          { httpStatus: 400 },
        );
      }
      if (codeSource.status !== 'ready') {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          codeSource.status === 'cloning'
            ? 'The code source is still being cloned. Start the review when it is ready.'
            : `The code source is not available: ${codeSource.error ?? 'refresh it and try again'}`,
          { httpStatus: 400 },
        );
      }
      const requestedModelCategory = await resolveRequestedModelCategory(modelId, modelCategory);
      const activeRunCount = await runService.countPlanConcurrentRuns(orgId);
      const subscription = await accessControl.enforceRunCreation({
        userId: actorId,
        organizationId: orgId,
        activeRunCount,
        requestedModelCategory,
        deferConcurrencyToAdmission: startRunService.usesQueuedCloudAdmission('cloud'),
      });
      await accessControl.enforceCodeReviewAccess({
        userId: actorId,
        organizationId: orgId,
      });
      await accessControl.enforceGitHubIntegrationAccess({
        userId: actorId,
        organizationId: orgId,
      });

      const snapshot = await codeSourceService.resolveCodeReviewRepositorySnapshot({
        orgId,
        scopeId,
        repository: codeSource.id,
      });
      const manifestFiles = filterCodeReviewManifestFiles({
        files: snapshot.files,
        allowedPaths,
        excludedPaths,
      });
      if (manifestFiles.length === 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          'The selected Code Review path policy does not include any files at the resolved commit',
        );
      }
      const manifestHash = buildCodeReviewManifestHash({
        immutableCommitSha: snapshot.immutableCommitSha,
        files: snapshot.files,
        allowedPaths,
        excludedPaths,
      });
      const codeReviewContext: CodeReviewContext = {
        operation: 'repository_review',
        repository: {
          provider: 'local',
          installationId: snapshot.installationId,
          repositoryId: snapshot.repositoryId,
          fullName: snapshot.fullName,
          visibility: snapshot.visibility,
          immutableCommitSha: snapshot.immutableCommitSha,
          requestedRef: snapshot.requestedRef,
          defaultBranch: snapshot.defaultBranch,
        },
        reviewScope: {
          mode: allowedPaths.length > 0 ? 'paths' : 'repository',
          allowedPaths,
          excludedPaths,
          contextReadPolicy: 'immutable_manifest_only',
          manifestHash,
          completeness: snapshot.completeness,
        },
        policySnapshot: {
          version: 'code-review/v1',
          toolProfile: 'code-review-read-only-v1',
          pathPolicy: 'immutable-manifest-bound',
          networkPolicy: 'local-source-no-network',
          publicationPolicy: 'none',
        },
      };

      const effectiveAutoApprove = true;
      const normalizedGoal =
        goal ??
        `Perform a security-focused Code Review of ${snapshot.fullName} at immutable commit ${snapshot.immutableCommitSha}.`;
      const startResult = await startRunService.startPlannerRun({
        orgId,
        userId: actorId,
        scopeId,
        goal: normalizedGoal,
        modelId,
        modelCategory,
        executionTarget: 'cloud',
        trigger: 'manual',
        toolPolicy: CODE_REVIEW_PLANNER_TOOL_POLICY,
        workflowDiscipline: 'code_review',
        codeReviewOperation: 'repository_review',
        codeReviewContext,
        codeReviewManifestFiles: snapshot.files,
        codeReviewRepositoryBrief: snapshot.reviewBrief,
        plannerPromptProfile: 'code-review-planner',
        autoApproveOnPlanning: effectiveAutoApprove,
        maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
        schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      });

      if (!startResult.idempotentReplay) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'code_review.created',
            resourceType: 'run',
            resourceId: startResult.run.id,
            changes: {
              after: {
                scopeId,
                repositoryId: snapshot.repositoryId,
                repository: snapshot.fullName,
                immutableCommitSha: snapshot.immutableCommitSha,
                manifestHash,
                manifestFileCount: manifestFiles.length,
                completeness: snapshot.completeness,
                status: startResult.run.status,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          logger.error({ err: toAppError(auditError), runId: startResult.run.id }, '[runs] Failed to write audit log for Code Review');
        }
      }

      res.status(startResult.idempotentReplay ? 200 : startResult.run.status === 'queued' ? 202 : 201).json({
        run: {
          ...withRunUiFlags(startResult.run),
          executionTarget: startResult.run.executionTarget,
          runnerId: customerRunnerId(startResult.run),
          runnerName: customerRunnerName(startResult.run, startResult.runnerName),
        },
        sessionId: startResult.sessionId,
        policySlug: startResult.policySlug,
        warnings: startResult.warnings,
        idempotentReplay: startResult.idempotentReplay,
        runner: startResult.run.executionTarget === 'cloud' ? null : startResult.runner,
        scheduling: schedulingProjection(startResult.run),
        codeReview: {
          repository: snapshot.fullName,
          immutableCommitSha: snapshot.immutableCommitSha,
          manifestHash,
          manifestFileCount: manifestFiles.length,
          completeness: snapshot.completeness,
        },
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to start Code Review');
      sendApiError(res, {
        code: err.code || ERROR_CODES.INTERNAL_UNEXPECTED,
        message: err.message || 'Failed to start Code Review',
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  // POST /api/app/runs/compliance-readiness-report - start a reporting-only compliance readiness session
  router.post('/compliance-readiness-report', async (req, res) => {
    try {
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
      }

      const workersEnabled = deps.enableWorkers ?? true;
      const appRole = deps.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is disabled on API-only nodes',
        });
      }

      const parsedBody = ComplianceReportCreateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        const issue = parsedBody.error.issues[0];
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: issue?.message ?? 'Invalid compliance report payload',
        });
      }

      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const userId = actorId ?? '';
      const {
        scopeId,
        framework,
        title: customTitle,
        sourceRunId: requestedSourceRunId,
        modelId,
        modelCategory,
        executionTarget = 'cloud',
        trigger = 'manual',
      } = parsedBody.data;

      await accessControl.enforceComplianceAccess({
        userId: actorId ?? undefined,
        organizationId: orgId,
      });
      const requestedModelCategory = await resolveRequestedModelCategory(modelId, modelCategory);
      if (executionTarget === 'scope_runner') {
        await accessControl.enforcePrivateRunnerAccess({
          userId: actorId ?? undefined,
          organizationId: orgId,
        });
      }
      const activeRunCount = await runService.countPlanConcurrentRuns(orgId);
      const subscription = await accessControl.enforceRunCreation({
        userId: actorId ?? undefined,
        organizationId: orgId,
        activeRunCount,
        requestedModelCategory,
        deferConcurrencyToAdmission: startRunService.usesQueuedCloudAdmission(executionTarget),
      });
      await scopeService.getById(orgId, scopeId);

      const readiness = await complianceReadinessService.getScopeReadiness({
        organizationId: orgId,
        scopeId,
      });
      const requestedFramework = readiness.frameworks.find((item) => item.key === framework);
      if (!requestedFramework) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Selected framework is not enabled in organization context or scope rules of engagement',
        });
      }
      if (!requestedFramework.supported) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: `${requestedFramework.label} reporting is selected but not implemented in this slice`,
        });
      }

      const sourceRunId = requestedSourceRunId ?? readiness.latestCompletedRunId ?? null;
      if (!sourceRunId) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Run a technical control assessment before starting a compliance readiness report session',
        });
      }
      if (sourceRunId) {
        const sourceRun = await runService.getById(orgId, sourceRunId);
        if (sourceRun.scopeId !== scopeId) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            message: 'Compliance report source run must belong to the selected scope',
          });
        }
      }

      const frameworkDefinition = FRAMEWORK_REGISTRY[framework];
      const frameworkLabel = frameworkDefinition?.label ?? requestedFramework.label;
      const reportTitle = customTitle ?? frameworkDefinition?.reportTitle ?? `${frameworkLabel} Report`;
      const startResult = await startRunService.startReportOnlyRun({
        orgId,
        userId,
        scopeId,
        goal:
          `Generate a ${frameworkLabel} report from existing NullSquare evidence for this scope. ` +
          'Use deterministic compliance readiness context, cite only canonical findings, notes, HTTP exchanges, scanner observations, inventory facts, or artifact paths, and do not claim audit attestation or certification.',
        title: reportTitle,
        mission: {
          id: 'compliance-readiness-report',
          phase: 'reporting',
          question: `Can the selected ${frameworkLabel} readiness evidence be packaged into a report without overstating compliance?`,
          whyReadyNow: 'The operator requested a dashboard compliance readiness report from selected scope context.',
          requiredEvidence: [
            '/workspace/.artifacts/report/context.json',
            '/workspace/.artifacts/report/compliance-context.json',
            'canonical findings, notes, HTTP exchanges, scanner observations, or inventory evidence referenced by the compliance readiness matrix',
          ],
          expectedArtifact: 'summary.md and report.md authored from prepared report context',
          stopCondition:
            'report_finalizer_preflight and prepare_report_context have been called, summary.md and report.md are authored with compliance boundary language, submit_phase_handoff is submitted, and finalize_run_artifacts succeeds.',
          assignedSkills: ['compliance-reporting'],
        },
        modelId,
        modelCategory,
        executionTarget,
        trigger,
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: framework,
        sourceRunId,
        vars: {
          complianceReport: {
            framework,
            source: 'dashboard-readiness',
            sourceRunId,
          },
        },
        securityOpsFlags: {
          complianceReport: {
            framework,
            source: 'dashboard-readiness',
            sourceRunId,
          },
        },
        maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
        schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.created',
            resourceType: 'run',
            resourceId: startResult.run.id,
            changes: {
              after: {
                scopeId,
                sessionId: startResult.sessionId,
                goal: startResult.run.goal,
                modelId: modelId ?? null,
                modelCategory: modelCategory ?? null,
                executionTarget,
                trigger,
                runnerId: startResult.runner?.id ?? null,
                status: startResult.run.status,
                complianceReport: {
                  framework,
                  sourceRunId,
                },
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const err = toAppError(auditError);
          logger.error(
            { err, runId: startResult.run.id },
            '[runs] Failed to write audit log for compliance report run creation',
          );
        }
      }

      res.status(startResult.run.status === 'queued' ? 202 : 201).json({
        run: {
          ...withRunUiFlags(startResult.run),
          executionTarget: startResult.run.executionTarget,
          runnerId: customerRunnerId(startResult.run),
          runnerName: customerRunnerName(startResult.run, startResult.runnerName),
        },
        sessionId: startResult.sessionId,
        phaseId: startResult.phaseId,
        policySlug: startResult.policySlug,
        warnings: startResult.warnings,
        runner: startResult.run.executionTarget === 'cloud' ? null : startResult.runner,
        scheduling: schedulingProjection(startResult.run),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to create compliance report run');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to create compliance report run',
      });
    }
  });

  // POST /api/app/runs/compliance-assessments - start a dedicated compliance readiness assessment
  router.post('/compliance-assessments', async (req, res) => {
    try {
      if (!isComplianceAgentWorkflowEnabled()) {
        return sendApiError(res, {
          code: ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
          status: 403,
          message: 'Compliance agent workflow is disabled',
        });
      }
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
      }

      const workersEnabled = deps.enableWorkers ?? true;
      const appRole = deps.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is disabled on API-only nodes',
        });
      }

      const parsedBody = ComplianceAssessmentCreateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        const issue = parsedBody.error.issues[0];
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: issue?.message ?? 'Invalid compliance assessment payload',
        });
      }

      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const userId = actorId ?? '';
      const {
        scopeId,
        framework,
        controlIds,
        title: customTitle,
        modelId,
        modelCategory,
        executionTarget = 'cloud',
        trigger = 'manual',
        focus = 'assessment',
      } = parsedBody.data;
      const evidenceMappingFocus = focus === 'evidence_mapping';
      const explicitControlIds = controlIds ? Array.from(new Set(controlIds)) : [];
      const plannerSelectsControls = explicitControlIds.length === 0;

      await accessControl.enforceComplianceAccess({
        userId: actorId ?? undefined,
        organizationId: orgId,
      });
      const requestedModelCategory = await resolveRequestedModelCategory(modelId, modelCategory);
      if (executionTarget === 'scope_runner') {
        await accessControl.enforcePrivateRunnerAccess({
          userId: actorId ?? undefined,
          organizationId: orgId,
        });
      }
      const activeRunCount = await runService.countPlanConcurrentRuns(orgId);
      const subscription = await accessControl.enforceRunCreation({
        userId: actorId ?? undefined,
        organizationId: orgId,
        activeRunCount,
        requestedModelCategory,
        deferConcurrencyToAdmission: startRunService.usesQueuedCloudAdmission(executionTarget),
      });
      const scopeDetail = await scopeService.getById(orgId, scopeId);
      const readiness = await complianceReadinessService.getScopeReadiness({
        organizationId: orgId,
        scopeId,
      });
      const selectedFramework = readiness.frameworks.find((item) => item.key === framework);
      const frameworkDefinition = FRAMEWORK_REGISTRY[framework];
      const frameworkLabel = frameworkDefinition?.label ?? selectedFramework?.label ?? framework;
      const readinessControlsById = new Map(
        (selectedFramework?.controls ?? []).map((control) => [control.id.toUpperCase(), control]),
      );
      const candidateControls = getPlannerAssessmentControls(framework).filter((control) => {
        const readinessControl = readinessControlsById.get(control.id.toUpperCase());
        return readinessControl?.monitoring.state === 'monitored';
      });
      const explicitSupportedControls = plannerSelectsControls
        ? candidateControls
        : getExplicitAssessmentControls(framework);
      const candidateControlIds = candidateControls.map((control) => control.id);
      const supportedExplicitControlIds = explicitSupportedControls.map((control) => control.id);
      const requestedControlIds = plannerSelectsControls ? candidateControlIds : explicitControlIds;
      const selectedControls = requestedControlIds
        .map((controlId) =>
          explicitSupportedControls.find((control) => control.id.toUpperCase() === controlId.toUpperCase()),
        )
        .filter((control): control is NonNullable<typeof control> => Boolean(control));
      const selectedControlIds = selectedControls.map((control) => control.id);
      const selectedControlIdSet = new Set(selectedControlIds.map((controlId) => controlId.toUpperCase()));
      const selectedReadinessControls = selectedControlIds
        .map((controlId) => readinessControlsById.get(controlId.toUpperCase()))
        .filter((control): control is NonNullable<typeof control> => Boolean(control));
      const missingControls = requestedControlIds.filter(
        (controlId) => !selectedControlIdSet.has(controlId.toUpperCase()),
      );
      if (
        !selectedFramework?.selected ||
        missingControls.length > 0 ||
        (plannerSelectsControls && candidateControlIds.length === 0)
      ) {
        const message = plannerSelectsControls
          ? candidateControlIds.length > 0
            ? `${frameworkLabel} readiness assessment planner mode supports monitored controls from ${SUPPORTED_COMPLIANCE_ASSESSMENT_PACK}: ${candidateControlIds.join(', ')}.`
            : `No monitored ${frameworkLabel} controls are enabled for this scope. Include at least one control before starting a compliance assessment.`
          : `${frameworkLabel} control workspace supports explicit controls: ${supportedExplicitControlIds.join(', ')}.`;
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message,
          userMessage: message,
        });
      }
      const candidateProofObligations = summarizeControlAssessmentObligations(framework, candidateControls);
      const candidateProofObligationIds = candidateProofObligations.map((proof) => proof.id);
      const proofObligations = summarizeControlAssessmentObligations(framework, selectedControls);
      const proofObligationIds = proofObligations.map((proof) => proof.id);
      const controlLabel = selectedControls.map((control) => `${control.id} ${control.title}`).join('; ');
      const pciDssProfileStatus =
        framework === 'pci_dss'
          ? summarizePciDssProfileStatus(scopeDetail, (await orgService.getOrgContext(orgId)).context)
          : null;
      const complianceAssessmentContext = {
        framework,
        focus,
        selectionMode: plannerSelectsControls ? 'planner' : 'explicit',
        supportedControlPack: SUPPORTED_COMPLIANCE_ASSESSMENT_PACK,
        monitoredControlIds: candidateControlIds,
        controlIds: selectedControlIds,
        proofObligationIds,
        proofObligations,
        controlReadiness: selectedReadinessControls.map((control) => ({
          controlId: control.id,
          title: control.title,
          supportLevel: control.supportLevel,
          implementationSpec: control.implementationSpec ?? null,
          pciDssRequirement: control.pciDssRequirement ?? null,
          pciDssGoal: control.pciDssGoal ?? null,
          pciDssApproach: control.pciDssApproach ?? null,
          pciDssSaqTypes: control.pciDssSaqTypes ?? null,
          pciDssCdeScope: control.pciDssCdeScope ?? null,
          pciDssAccountData: control.pciDssAccountData ?? null,
          status: control.status,
          verdict: control.verdict,
          outcome: control.outcome,
          nextAction: control.nextAction,
          openRequestCount: control.actionRequests.filter((request) =>
            ['open', 'fulfilled', 'insufficient', 'contradicted'].includes(request.status),
          ).length,
          latestCheckVerdict: control.controlChecks[0]?.verdict ?? null,
          latestCheckFresh: control.controlChecks[0]?.fresh ?? null,
        })),
        excludedControls: (selectedFramework?.controls ?? [])
          .filter((control) => control.monitoring.state !== 'monitored')
          .map((control) => ({
            controlId: control.id,
            state: control.monitoring.state,
            reason: control.monitoring.exclusionReason ?? control.verdictReason,
          })),
        candidateControlIds,
        candidateProofObligationIds,
        candidateProofObligations,
        pciDssProfileStatus,
      };

      const effectiveAutoApprove = true;
      const goal = evidenceMappingFocus
        ? [
            `Dedicated ${frameworkLabel} evidence mapping review.`,
            plannerSelectsControls
              ? `Planner should use monitored ${frameworkLabel} controls as the mapping universe: ${controlLabel}.`
              : `Review uploaded and integration evidence against these explicitly selected ${frameworkLabel} controls: ${controlLabel}.`,
            pciDssProfileStatus
              ? `PCI DSS profile context: ${pciDssProfileStatus.summary} Use uploaded evidence to clarify CDE boundary, account-data flows, SAQ type, merchant level, or service-provider role when available; request it when missing.`
              : '',
            `Uploaded evidence arrives as bare files with no metadata. Read each unmapped item and call annotate_compliance_evidence to set a clear title, a description of what it is and what it proves, the evidence type, and a freshness window (validUntil) so it can be reused across frameworks later. Use query_compliance_evidence to find unmapped, under-mapped, and system_suggested evidence; include content previews only when needed. Use map_compliance_evidence to propose control mappings with rationale, confidence, and citation anchors. Mappings are context only: when evidence is sufficient, record_control_check with basis=agent_reviewed_user_evidence or agent_reviewed_integration and cite the compliance-evidence refs; otherwise create or refresh specific record_control_request items.`,
          ]
            .filter((part) => part.trim().length > 0)
            .join(' ')
        : [
            `Dedicated ${frameworkLabel} readiness assessment.`,
            plannerSelectsControls
              ? `Planner must cover every monitored ${frameworkLabel} control in this run context: ${controlLabel}.`
              : `Assess these explicitly selected ${frameworkLabel} controls for the selected scope: ${controlLabel}.`,
            pciDssProfileStatus
              ? `PCI DSS profile context: ${pciDssProfileStatus.summary} If CDE boundary, account-data flows, SAQ type, merchant level, or service-provider role are missing or ambiguous, create or refresh a specific record_control_request before making PCI scope-sensitive verdicts.`
              : '',
            `Uploaded evidence arrives as bare files. For any unmapped or undescribed compliance-evidence items, use annotate_compliance_evidence to set a clear title, description, type, and validUntil, then map_compliance_evidence to link them to the relevant controls with rationale and citation anchors before deciding verdicts. Mappings are advisory: credit only comes from a record_control_check that cites the evidence.`,
            plannerSelectsControls
              ? `Use query_compliance_readiness history, inventory, available evidence, and obligations ${proofObligationIds.join(', ')}. For each monitored control, produce a fresh record_control_check, review fulfilled evidence, or create/refresh a specific record_control_request for missing evidence, access, context, or remediation before reporting.`
              : `Use obligations ${proofObligationIds.join(', ')}. For each selected control, produce a fresh record_control_check, review fulfilled evidence, or create/refresh a specific record_control_request before reporting. For evidence-review obligations, evaluate mapped uploaded or integration evidence and cite compliance-evidence refs in record_control_check.`,
          ]
            .filter((part) => part.trim().length > 0)
            .join(' ');

      const startResult = await startRunService.startPlannerRun({
        orgId,
        userId,
        scopeId,
        goal,
        title:
          customTitle ??
          (evidenceMappingFocus
            ? `${frameworkLabel} Evidence Mapping Review`
            : `${frameworkLabel} Readiness Assessment`),
        modelId,
        modelCategory,
        executionTarget,
        trigger: trigger as 'manual' | 'scheduled' | 'event',
        vars: {
          complianceAssessment: complianceAssessmentContext,
        },
        securityOpsFlags: {
          complianceAssessment: complianceAssessmentContext,
        },
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: framework,
        plannerPromptProfile: 'compliance-planner',
        planningSkillSlugs: ['compliance-planning'],
        toolPolicy: COMPLIANCE_PLANNER_TOOL_POLICY,
        autoApproveOnPlanning: effectiveAutoApprove,
        maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
        schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.created',
            resourceType: 'run',
            resourceId: startResult.run.id,
            changes: {
              after: {
                scopeId,
                sessionId: startResult.sessionId,
                goal: startResult.run.goal,
                modelId: modelId ?? null,
                modelCategory: modelCategory ?? null,
                executionTarget,
                trigger,
                runnerId: startResult.runner?.id ?? null,
                status: startResult.run.status,
                complianceAssessment: {
                  framework,
                  focus,
                  selectionMode: complianceAssessmentContext.selectionMode,
                  supportedControlPack: SUPPORTED_COMPLIANCE_ASSESSMENT_PACK,
                  candidateControlIds,
                  controlIds: selectedControlIds,
                  proofObligationIds,
                },
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, runId: startResult.run.id },
            '[runs] Failed to write audit log for compliance assessment run creation',
          );
        }
      }

      res.status(startResult.idempotentReplay ? 200 : startResult.run.status === 'queued' ? 202 : 201).json({
        run: {
          ...withRunUiFlags(startResult.run),
          executionTarget: startResult.run.executionTarget,
          runnerId: customerRunnerId(startResult.run),
          runnerName: customerRunnerName(startResult.run, startResult.runnerName),
        },
        sessionId: startResult.sessionId,
        policySlug: startResult.policySlug,
        warnings: startResult.warnings,
        idempotentReplay: startResult.idempotentReplay || undefined,
        runner: startResult.run.executionTarget === 'cloud' ? null : startResult.runner,
        scheduling: schedulingProjection(startResult.run),
        complianceAssessment: complianceAssessmentContext,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to create compliance assessment run');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to create compliance assessment run',
      });
    }
  });

  router.post('/compliance-baseline-assessment', (_req, res) => sendRetiredComplianceAssessmentRoute(res));
  router.post('/compliance-gap-assessment', (_req, res) => sendRetiredComplianceAssessmentRoute(res));

  // GET /api/app/runs/:id - run detail (enriched)
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await runService.getById(orgId, req.params.id);
      const runnerNameById = new Map(
        (await runnerService.listRunners(orgId)).map((runner) => [runner.id, runner.name]),
      );

      let scopeName = 'Unknown';
      let impactTolerance: 'non_destructive' | 'poc' | 'full' = 'non_destructive';
      try {
        const sd = await scopeService.getById(orgId, detail.scopeId);
        scopeName = sd.scope.name;
        impactTolerance =
          sd.scope.impactTolerance === 'full' || sd.scope.impactTolerance === 'poc'
            ? sd.scope.impactTolerance
            : 'non_destructive';
      } catch {
        /* scope may have been deleted */
      }

      res.json({
        ...withRunUiFlags(detail),
        displayId: typeof detail.displayId === 'number' ? `#r${detail.displayId}` : `#r${detail.id.slice(0, 4)}`,
        scopeName,
        impactTolerance,
        findingsDiscovered: detail.findingsCount,
        inventoryChanges: `+${detail.inventoryAdded}`,
        runnerId: customerRunnerId(detail),
        runnerName: customerRunnerName(detail, detail.runnerId ? runnerNameById.get(detail.runnerId) : null),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to get run');
      sendApiError(res, {
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Run not found',
      });
    }
  });

  // POST /api/app/runs/:id/approve — approve planner output and start executor
  router.post('/:id/approve', async (req, res) => {
    try {
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
      }

      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const userId = actorId ?? '';
      const approvalBody = RunApproveBodySchema.safeParse(req.body ?? {});
      if (!approvalBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Approval body is invalid',
          details: approvalBody.error.flatten(),
        });
      }
      const detail = await runService.getById(orgId, req.params.id);
      if (!detail.goal) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Only goal-based planner runs can be approved with this endpoint',
        });
      }
      if (!isRunAwaitingPlanApproval(detail)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Run is not awaiting plan approval',
        });
      }

      if (!detail.plan?.trim()) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Run plan is missing. Re-run planning before approval.',
        });
      }
      const approval = await startRunService.approveRun({
        orgId,
        runId: detail.id,
        userId,
        approvalSource: 'user',
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.approved',
            resourceType: 'run',
            resourceId: detail.id,
            changes: {
              before: {
                status: detail.status,
                sessionId: detail.sessionId,
              },
              after: {
                status: approval.run.status,
                sessionId: approval.sessionId,
                executorSessionId: approval.sessionId,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, runId: detail.id }, '[runs] Failed to write audit log for run approval');
        }
      }

      res.json({
        run: {
          ...withRunUiFlags(approval.run),
          executionTarget: approval.run.executionTarget,
          runnerId: customerRunnerId(approval.run),
          runnerName: customerRunnerName(approval.run, approval.runnerName),
        },
        sessionId: approval.sessionId,
        policySlug: approval.policySlug,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to approve run');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to approve run',
      });
    }
  });

  // POST /api/app/runs/:id/reject — reject planner output and cancel run
  router.post('/:id/reject', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const detail = await runService.getById(orgId, req.params.id);
      if (!detail.goal) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Only goal-based planner runs can be rejected with this endpoint',
        });
      }
      if (!isRunAwaitingPlanApproval(detail)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: 'Run is not awaiting plan approval',
        });
      }

      await runService.cancel(orgId, detail.id);

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.rejected',
            resourceType: 'run',
            resourceId: detail.id,
            changes: {
              before: { status: detail.status },
              after: { status: 'cancelled', reason: 'planner_rejected' },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, runId: detail.id }, '[runs] Failed to write audit log for run rejection');
        }
      }

      res.json({ success: true });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to reject run');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to reject run',
      });
    }
  });

  // POST /api/app/runs/:id/plan-feedback — request planner revisions
  router.post('/:id/plan-feedback', async (req, res) => {
    try {
      if (!startRunService) {
        return sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
      }

      const parsedBody = PlanFeedbackBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        const issue = parsedBody.error.issues[0];
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: issue?.message ?? 'Invalid feedback payload',
        });
      }

      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const detail = await runService.getById(orgId, req.params.id);
      const result = await startRunService.requestPlanFeedback({
        orgId,
        runId: detail.id,
        feedback: parsedBody.data.feedback,
      });

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.plan_feedback_requested',
            resourceType: 'run',
            resourceId: detail.id,
            changes: {
              before: {
                status: detail.status,
                plan: detail.plan ?? null,
              },
              after: {
                status: result.run.status,
                plannerSessionId: result.plannerSessionId,
                feedback: parsedBody.data.feedback,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error(
            { err: auditErr, runId: detail.id },
            '[runs] Failed to write audit log for plan feedback request',
          );
        }
      }

      res.status(202).json({
        success: true,
        run: withRunUiFlags(result.run),
        plannerSessionId: result.plannerSessionId,
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to request plan feedback');
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to request plan feedback',
      });
    }
  });

  // POST /api/app/runs/:id/cancel — cancel run
  router.post('/:id/cancel', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const actorId = req.user?.id ?? null;
      const detail = await runService.getById(orgId, req.params.id);
      const reason = 'run_cancelled_by_operator';

      try {
        await abortLiveRunSessions({
          runId: detail.id,
          services: deps.services,
          sessionRepository,
          caller: 'runs.router.cancel',
        });
      } finally {
        // A run is terminal only after active turns were asked to abort and
        // given a bounded opportunity to settle their provider accounting.
        await runService.cancel(orgId, req.params.id);
      }

      if (actorId) {
        try {
          await auditService.log({
            organizationId: orgId,
            actorId,
            actorType: 'user',
            action: 'run.cancelled',
            resourceType: 'run',
            resourceId: detail.id,
            changes: {
              before: {
                status: detail.status,
              },
              after: {
                status: 'cancelled',
                reason,
              },
            },
            metadata: buildAuditMetadata(req),
          });
        } catch (auditError) {
          const auditErr = toAppError(auditError);
          logger.error({ err: auditErr, runId: detail.id }, '[runs] Failed to write audit log for run cancellation');
        }
      }

      res.json({ success: true });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to cancel run');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to cancel run',
      });
    }
  });

  // GET /api/app/runs/:id/phases - phase sessions for Workbench navigation
  router.get('/:id/phases', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await runService.getById(orgId, req.params.id);
      await accessControl.enforceRunObservabilityAccess({
        userId: req.user?.id,
        organizationId: orgId,
      });
      const rows = await runPhaseRepository.listByRunId(detail.id);
      res.json(projectRunPhaseRows(rows, detail.status));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, runId: req.params.id }, '[runs] Failed to get phases');
      if (err.httpStatus === 404) {
        sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Run not found',
        });
        return;
      }
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get phases',
      });
    }
  });

  // GET /api/app/runs/:id/activity - run activity summary
  router.get('/:id/activity', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await runService.getById(orgId, req.params.id);
      await accessControl.enforceRunObservabilityAccess({
        userId: req.user?.id,
        organizationId: orgId,
      });
      const activity = await runActivityService.getSummaryForRun(detail);
      res.json(activity);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, runId: req.params.id }, '[runs] Failed to get activity');
      if (err.httpStatus === 404) {
        sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Run not found',
        });
        return;
      }
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
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get activity',
      });
    }
  });

  // GET /api/app/runs/:id/compliance-readiness - run-specific compliance readiness projection
  router.get('/:id/compliance-readiness', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      await accessControl.enforceComplianceAccess({
        userId: req.user?.id,
        organizationId: orgId,
      });
      const detail = await runService.getById(orgId, req.params.id);
      const readiness = await complianceReadinessService.getRunReadiness({
        organizationId: orgId,
        runId: detail.id,
      });
      res.json(readiness);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, runId: req.params.id }, '[runs] Failed to get compliance readiness');
      if (err.httpStatus === 404 || err.message === 'Run not found') {
        sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Run not found',
        });
        return;
      }
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get compliance readiness',
      });
    }
  });

  // GET /api/app/runs/:id/events - run timeline
  router.get('/:id/events', async (req, res) => {
    try {
      await ensureRunOwned(req, req.params.id);
      const events = await runService.getEvents(req.params.id);
      res.json(events);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to get events');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get events',
      });
    }
  });

  // GET /api/app/runs/:id/findings — findings from this run
  router.get('/:id/code-review', async (req, res) => {
    try {
      const actorId = req.user?.id;
      if (!actorId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }
      const orgId = await ensureRunOwned(req, req.params.id);
      await accessControl.enforceCodeReviewAccess({
        userId: actorId,
        organizationId: orgId,
      });
      const bundle = await codeReviewFindingService.getBundle({
        organizationId: orgId,
        runId: req.params.id,
      });
      res.json(bundle);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, runId: req.params.id }, '[runs] Failed to get Code Review bundle');
      sendApiError(res, {
        code: err.code || ERROR_CODES.INTERNAL_UNEXPECTED,
        message: err.message || 'Failed to get Code Review',
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.post('/:id/code-review/findings/:findingId/fix', async (req, res) => {
    try {
      const actorId = req.user?.id;
      if (!actorId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }
      const orgId = await ensureRunOwned(req, req.params.id);
      await accessControl.enforceCodeReviewAccess({
        userId: actorId,
        organizationId: orgId,
      });
      const parsedBody = CodeReviewFixRequestBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: parsedBody.error.issues[0]?.message ?? 'Invalid Code Review fix request',
        });
      }
      const fixRequest = await codeReviewFindingService.requestFix({
        organizationId: orgId,
        runId: req.params.id,
        findingId: req.params.findingId,
        findingVersion: parsedBody.data.findingVersion,
        vulnerableCommitSha: parsedBody.data.vulnerableCommitSha,
        requestedByUserId: actorId,
      });
      await auditService.log({
        organizationId: orgId,
        actorId,
        actorType: 'user',
        action: 'code_review.fix_requested',
        resourceType: 'code_review_finding',
        resourceId: req.params.findingId,
        changes: {
          after: {
            fixRequestId: fixRequest.id,
            findingVersion: fixRequest.findingVersion,
            vulnerableCommitSha: fixRequest.vulnerableCommitSha,
            status: fixRequest.status,
          },
        },
        metadata: buildAuditMetadata(req),
      });
      res.status(fixRequest.status === 'requested' ? 202 : 200).json(fixRequest);
    } catch (error) {
      const err = toAppError(error);
      logger.error(
        { err, runId: req.params.id, findingId: req.params.findingId },
        '[runs] Failed to request Code Review fix',
      );
      sendApiError(res, {
        code: err.code || ERROR_CODES.INTERNAL_UNEXPECTED,
        message: err.message || 'Failed to request Code Review fix',
        status: err.httpStatus,
        context: err.context,
        userMessage: err.message,
      });
    }
  });

  router.get('/:id/findings', async (req, res) => {
    try {
      const orgId = await ensureRunOwned(req, req.params.id);
      const run = await runService.getById(orgId, req.params.id);
      if (run.workflowDiscipline === 'code_review') {
        const bundle = await codeReviewFindingService.getBundle({
          organizationId: orgId,
          runId: req.params.id,
        });
        res.json(bundle.findings);
        return;
      }
      const runFindings = await runService.getFindings(req.params.id);
      res.json(runFindings);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to get findings');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get findings',
      });
    }
  });

  // GET /api/app/runs/:id/inventory-diff — inventory changes
  router.get('/:id/inventory-diff', async (req, res) => {
    try {
      await ensureRunOwned(req, req.params.id);
      const diff = await runService.getInventoryDiff(req.params.id);
      res.json(diff);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[runs] Failed to get inventory diff');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get inventory diff',
      });
    }
  });

  return router;
}
