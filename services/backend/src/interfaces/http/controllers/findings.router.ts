import { Router, type Request, type Response } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  assets,
  agentArtifacts,
  findingEvidence,
  findingEvents,
  findings,
  inventoryNotes,
  inventoryServices,
  organizationMembers,
  runEvents,
  scopes,
  type RiskState,
} from '@/db/schema';
import { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { ScopeAccessMaterialService } from '@/domains/security-ops/scopes/ScopeAccessMaterialService';
import { AutomationService } from '@/domains/security-ops/automations/AutomationService';
import { RunnerService } from '@/domains/security-ops/runners/RunnerService';
import { AuditService } from '@/domains/security-ops/audit/AuditService';
import { FailedEventService } from '@/domains/security-ops/resilience/FailedEventService';
import {
  RunService,
  encodeFindingLifecycleRunNote,
  type FindingLifecycleMode,
  type RunServiceSkillContextPort,
} from '@/domains/security-ops/runs/RunService';
import { StartRunService } from '@/domains/security-ops/runs/StartRunService';
import { WorkspaceProjectionService } from '@/domains/security-ops/workspace/WorkspaceProjectionService';
import { securityOpsRunSkillContextService } from '@/domains/security-ops/runs/RunSkillContextService';
import {
  buildFindingEvidenceArtifactLookup,
  resolveFindingEvidenceArtifact,
} from '@/domains/security-ops/evidence/findingEvidenceArtifacts';
import {
  buildFindingReviewMeta,
  normalizeFindingEvidenceKind,
  normalizeStoredCodeLocations,
  type FindingHttpExchange,
} from '@/domains/security-ops/findings/findingContracts';
import { SessionService } from '@/domains/agent-brain/application/services/SessionService';
import { createAgentRepositories, type AgentRepositories } from '@/app/services/agent/agentRepositories';
import { createSubscriptionPort, createModelConfigPort } from '@/app/adapters/portFactories';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import { schedulingClassForPlan } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';
import type { AgentApiServices } from '@/app/services/agent/types';
import type { SubscriptionPort, ModelConfigPort } from '@/domains/agent-brain/ports';
import type { ToolAccessPolicy } from '@/domains/agent-brain/domain/types';
import { ERROR_CODES, sendApiError, toAppError } from '@/shared/errors';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import { requireFindingOrgContext, requirePrimaryOrgContext } from '@/interfaces/http/middleware/orgContext';
import { logger } from '@/shared/logger';
import type { AttackResultV1 } from '@/domains/agent-brain/domain/workers/attackContracts';
import { FindingDispositionVerificationService } from '@/domains/security-ops/findings/FindingDispositionVerificationService';
import { abortLiveRunSessions } from '@/domains/security-ops/runs/cancelLiveRunSessions';
import { customerRunnerName, schedulingProjection, withRunUiFlags } from './runPublicProjection';
import {
  DIRECTLY_EDITABLE_RISK_STATES,
  isDirectRiskStateTransitionAllowed,
} from '@/domains/security-ops/risks/riskLifecycle';
type BulkAction = 'assign' | 'set_state';
type FindingFixEffort = 'trivial' | 'low' | 'medium' | 'high';
type FindingEndpointContext = { id: string; url: string; method: string };
type FindingServiceContext = {
  id: string;
  protocol: string;
  port: number;
  serviceName: string | null;
  product: string | null;
  version: string | null;
};
type FindingEvidenceListRow = {
  id: string;
  sessionId: string | null;
  kind: string | null;
  path: string;
  displayPath: string | null;
  label: string | null;
  excerpt: string | null;
  fileMissing: boolean;
  data: FindingHttpExchange | AttackResultV1 | null;
  createdAt: Date | string | null;
};
type FindingEvidenceResponse =
  | {
      id: string;
      kind: 'artifact';
      path: string;
      displayPath: string;
      label?: string;
      excerpt?: string;
      fileMissing: boolean;
      sessionId?: string;
      artifactId?: string;
      downloadPath?: string;
      createdAt?: string | null;
    }
  | {
      id: string;
      kind: 'http_exchange';
      path: string;
      displayPath: string;
      label?: string;
      createdAt?: string | null;
      http: FindingHttpExchange;
    };

const MAX_BULK_IDS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_EDITABLE_RISK_STATES = new Set<RiskState>(DIRECTLY_EDITABLE_RISK_STATES);
const ALLOWED_FIX_EFFORT = new Set<FindingFixEffort>(['trivial', 'low', 'medium', 'high']);
const PLANNER_TOOL_POLICY: ToolAccessPolicy = {
  allow: ['submit_plan', 'query_inventory', 'query_findings', 'query_notes', 'file_read', 'file_write'],
};

const buildAuditMetadata = (req: { requestId?: string; ip?: string; get: (name: string) => string | undefined }) => ({
  requestId: req.requestId ?? null,
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeFindingEndpoint = (
  row:
    | {
        id: string;
        data: unknown;
      }
    | undefined,
): FindingEndpointContext | null => {
  if (!row) return null;
  const data = isRecord(row.data) ? row.data : {};
  const url = typeof data['url'] === 'string' ? data['url'].trim() : '';
  const methodRaw = typeof data['method'] === 'string' ? data['method'].trim() : '';
  const method = methodRaw ? methodRaw.toUpperCase() : 'GET';
  if (!url) return null;
  return { id: row.id, url, method };
};

type FindingsRouterDeps = {
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

export function createFindingsRouter(deps: FindingsRouterDeps = {}): Router {
  const router = Router();
  const orgService = new OrganizationService(db);
  const scopeService = new ScopeService(db);
  const runnerService = new RunnerService(db);
  const auditService = new AuditService(db);
  const failedEventService = new FailedEventService(db);
  const kernel = deps.kernel ?? createPlatformKernel();
  const repositories = deps.repositories ?? createAgentRepositories();
  const sessionRepository = deps.sessionRepository ?? repositories.sessionRepository;
  const skillContextService = deps.skillContextService ?? securityOpsRunSkillContextService;
  const runService = new RunService(db, orgService, scopeService, {
    sessionStatusPort: sessionRepository,
    skillContextService,
  });
  const workspaceProjectionService = new WorkspaceProjectionService(db);
  const automationService = new AutomationService({ db });
  const accessControl = deps.accessControl ?? kernel.accessControl;
  const subscriptionPort = deps.subscriptionPort ?? createSubscriptionPort(accessControl);
  const modelConfigPort = deps.modelConfigPort ?? createModelConfigPort();
  const dispositionVerificationService = new FindingDispositionVerificationService(db);

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

  async function getFindingOwned(orgId: string, findingId: string) {
    const [row] = await db
      .select()
      .from(findings)
      .where(and(eq(findings.organizationId, orgId), eq(findings.id, findingId)))
      .limit(1);
    return row ?? null;
  }

  async function loadEndpointContextMap(endpointIds: string[]) {
    const uniqueIds = [...new Set(endpointIds.filter((value): value is string => Boolean(value)))];
    if (uniqueIds.length === 0) return new Map<string, FindingEndpointContext>();

    const rows = await db
      .select({ id: inventoryNotes.id, data: inventoryNotes.data })
      .from(inventoryNotes)
      .where(inArray(inventoryNotes.id, uniqueIds));

    const endpointMap = new Map<string, FindingEndpointContext>();
    for (const row of rows) {
      const endpoint = normalizeFindingEndpoint(row);
      if (endpoint) endpointMap.set(row.id, endpoint);
    }
    return endpointMap;
  }

  async function loadServiceContextMap(serviceIds: string[]) {
    const uniqueIds = [...new Set(serviceIds.filter((value): value is string => Boolean(value)))];
    if (uniqueIds.length === 0) return new Map<string, FindingServiceContext>();

    const rows = await db
      .select({
        id: inventoryServices.id,
        protocol: inventoryServices.protocol,
        port: inventoryServices.port,
        serviceName: inventoryServices.serviceName,
        product: inventoryServices.product,
        version: inventoryServices.version,
      })
      .from(inventoryServices)
      .where(inArray(inventoryServices.id, uniqueIds));

    return new Map(rows.map((row) => [row.id, row]));
  }

  async function loadFindingEvidenceRows(findingId: string): Promise<FindingEvidenceListRow[]> {
    return db
      .select({
        id: findingEvidence.id,
        sessionId: findingEvidence.sessionId,
        kind: findingEvidence.kind,
        path: findingEvidence.path,
        displayPath: findingEvidence.displayPath,
        label: findingEvidence.label,
        excerpt: findingEvidence.excerpt,
        fileMissing: findingEvidence.fileMissing,
        data: findingEvidence.data,
        createdAt: findingEvidence.createdAt,
      })
      .from(findingEvidence)
      .where(eq(findingEvidence.findingId, findingId))
      .orderBy(desc(findingEvidence.createdAt));
  }

  async function mapFindingEvidence(rows: FindingEvidenceListRow[]): Promise<FindingEvidenceResponse[]> {
    const sessionIds = [
      ...new Set(rows.map((row) => row.sessionId).filter((value): value is string => Boolean(value))),
    ];
    const artifactRows =
      sessionIds.length > 0
        ? await db
            .select({
              id: agentArtifacts.id,
              sessionId: agentArtifacts.sessionId,
              originalName: agentArtifacts.originalName,
              filePath: agentArtifacts.filePath,
            })
            .from(agentArtifacts)
            .where(inArray(agentArtifacts.sessionId, sessionIds))
        : [];
    const artifactLookup = buildFindingEvidenceArtifactLookup(artifactRows);

    return rows.map((row) => {
      const kind = normalizeFindingEvidenceKind(row.kind);
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt;
      if (kind === 'http_exchange') {
        return {
          id: row.id,
          kind,
          path: row.path,
          displayPath: row.displayPath ?? row.path,
          ...(row.label ? { label: row.label } : {}),
          createdAt,
          http: (row.data ?? {
            request: { method: 'GET', url: row.displayPath ?? row.path },
            response: { statusCode: 0 },
          }) as FindingHttpExchange,
        };
      }

      return {
        ...resolveFindingEvidenceArtifact(
          {
            sessionId: row.sessionId,
            path: row.path,
            fileMissing: row.fileMissing,
          },
          artifactLookup,
        ),
        id: row.id,
        kind,
        path: row.path,
        displayPath: row.displayPath ?? row.path,
        ...(row.label ? { label: row.label } : {}),
        ...(row.excerpt ? { excerpt: row.excerpt } : {}),
        createdAt,
      };
    });
  }

  async function mapFindingDetail(orgId: string, findingId: string) {
    const row = await getFindingOwned(orgId, findingId);
    if (!row) return null;

    let assetInfo = { value: '-', kind: 'unknown' };
    let scopeName = 'Unknown';

    if (row.assetId) {
      const [asset] = await db
        .select({ value: assets.value, kind: assets.kind })
        .from(assets)
        .where(eq(assets.id, row.assetId))
        .limit(1);
      if (asset) assetInfo = asset;
    }

    if (row.scopeId) {
      const [scope] = await db.select({ name: scopes.name }).from(scopes).where(eq(scopes.id, row.scopeId)).limit(1);
      if (scope) scopeName = scope.name;
    }

    const evidenceRows = await loadFindingEvidenceRows(findingId);
    const mappedEvidence = await mapFindingEvidence(evidenceRows);
    const codeLocations = normalizeStoredCodeLocations(row.codeLocations);
    const reviewMeta = buildFindingReviewMeta({
      codeLocations,
      evidence: mappedEvidence.map((evidence) => ({
        kind: evidence.kind,
        excerpt: evidence.kind === 'artifact' ? evidence.excerpt : null,
        fileMissing: evidence.kind === 'artifact' ? evidence.fileMissing : false,
        hasDownloadableArtifact: evidence.kind === 'artifact' && Boolean(evidence.downloadPath),
      })),
    });

    const [endpointMap, serviceMap] = await Promise.all([
      row.endpointId
        ? loadEndpointContextMap([row.endpointId])
        : Promise.resolve(new Map<string, FindingEndpointContext>()),
      row.serviceId
        ? loadServiceContextMap([row.serviceId])
        : Promise.resolve(new Map<string, FindingServiceContext>()),
    ]);
    const dispositionVerification = await dispositionVerificationService.getHistory({
      organizationId: orgId,
      findingId,
    });

    return {
      ...row,
      confidence: row.confidenceScore,
      evidenceCount: mappedEvidence.length,
      assetValue: assetInfo.value,
      assetKind: assetInfo.kind,
      scopeName,
      endpoint: row.endpointId ? (endpointMap.get(row.endpointId) ?? null) : null,
      service: row.serviceId ? (serviceMap.get(row.serviceId) ?? null) : null,
      codeLocations,
      reviewMeta,
      dispositionVerification: {
        active: dispositionVerification.active,
        latest: dispositionVerification.latest,
      },
      firstSeenAt: row.firstSeenAt instanceof Date ? row.firstSeenAt.toISOString() : row.firstSeenAt,
      lastSeenAt: row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : row.lastSeenAt,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    };
  }

  router.get('/:id([0-9a-fA-F-]{36})', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const detail = await mapFindingDetail(orgId, req.params.id);
      if (!detail) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Finding not found',
        });
      }
      res.json(detail);
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[findings] Failed to get finding detail');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get finding',
      });
    }
  });

  router.get('/:id([0-9a-fA-F-]{36})/evidence', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const findingRow = await getFindingOwned(orgId, req.params.id);
      if (!findingRow) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Finding not found',
        });
      }

      const evidenceRows = await loadFindingEvidenceRows(req.params.id);

      res.json(await mapFindingEvidence(evidenceRows));
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[findings] Failed to get evidence');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get evidence',
      });
    }
  });

  // GET /api/app/findings/:id/events — full finding timeline
  router.get('/:id([0-9a-fA-F-]{36})/events', async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const findingRow = await getFindingOwned(orgId, req.params.id);
      if (!findingRow) {
        return sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Finding not found',
        });
      }

      const rows = await db
        .select()
        .from(findingEvents)
        .where(eq(findingEvents.findingId, req.params.id))
        .orderBy(asc(findingEvents.createdAt));

      res.json(
        rows.map((row) => ({
          ...row,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
        })),
      );
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err }, '[findings] Failed to get events');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to get events',
      });
    }
  });

  const cancelVerificationRuns = async (
    organizationId: string,
    runIds: readonly string[],
    caller: string,
  ): Promise<void> => {
    for (const runId of Array.from(new Set(runIds.filter(Boolean)))) {
      try {
        await abortLiveRunSessions({
          runId,
          services: deps.services,
          sessionRepository,
          caller,
        });
      } finally {
        await runService.cancel(organizationId, runId, 'finding_disposition_superseded');
      }
    }
  };

  const sendDispositionError = (res: Response, error: unknown, message: string) => {
    const err = toAppError(error);
    logger.error({ err }, message);
    sendApiError(res, {
      code: err.code,
      message: err.message,
      status: err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 500,
    });
  };

  router.get(
    '/:id([0-9a-fA-F-]{36})/disposition-verifications',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const organizationId = await getOrgId(req);
        const findingRow = await getFindingOwned(organizationId, req.params.id);
        if (!findingRow) {
          return sendApiError(res, {
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Finding not found',
          });
        }
        res.json(
          await dispositionVerificationService.getHistory({
            organizationId,
            findingId: findingRow.id,
          }),
        );
      } catch (error) {
        sendDispositionError(res, error, '[findings] Failed to list disposition verifications');
      }
    },
  );

  router.post(
    '/:id([0-9a-fA-F-]{36})/disposition-verifications',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const organizationId = await getOrgId(req);
        const requestedByUserId = req.user?.id;
        if (!requestedByUserId) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            message: 'Not authenticated',
          });
        }
        const findingRow = await getFindingOwned(organizationId, req.params.id);
        if (!findingRow) {
          return sendApiError(res, {
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Finding not found',
          });
        }
        const body = (req.body ?? {}) as {
          requestedState?: unknown;
          reason?: unknown;
          requestKey?: unknown;
        };
        if (body.requestedState !== 'resolved' && body.requestedState !== 'dismissed') {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'requestedState must be resolved or dismissed',
          });
        }
        if (typeof body.requestKey !== 'string' || !body.requestKey.trim()) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
            message: 'requestKey is required',
          });
        }
        const result = await dispositionVerificationService.request({
          organizationId,
          findingId: findingRow.id,
          requestedByUserId,
          requestedState: body.requestedState,
          requestKey: body.requestKey,
          reason: typeof body.reason === 'string' ? body.reason : null,
        });
        await cancelVerificationRuns(
          organizationId,
          result.supersededRunIds,
          'findings.disposition_verifications.create',
        );
        const history = await dispositionVerificationService.getHistory({
          organizationId,
          findingId: findingRow.id,
        });
        res.status(result.idempotentReplay ? 200 : 202).json({
          verification: result.verification,
          idempotentReplay: result.idempotentReplay,
          active: history.active,
          latest: history.latest,
        });
      } catch (error) {
        sendDispositionError(res, error, '[findings] Failed to request disposition verification');
      }
    },
  );

  router.post(
    '/:id([0-9a-fA-F-]{36})/disposition-verifications/:verificationId([0-9a-fA-F-]{36})/retry',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const organizationId = await getOrgId(req);
        const requestedByUserId = req.user?.id;
        if (!requestedByUserId) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            message: 'Not authenticated',
          });
        }
        const requestKey = typeof req.body?.requestKey === 'string' ? req.body.requestKey : '';
        if (!requestKey.trim()) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
            message: 'requestKey is required',
          });
        }
        const verification = await dispositionVerificationService.retry({
          organizationId,
          findingId: req.params.id,
          verificationId: req.params.verificationId,
          requestedByUserId,
          requestKey,
        });
        res.status(202).json({ verification });
      } catch (error) {
        sendDispositionError(res, error, '[findings] Failed to retry disposition verification');
      }
    },
  );

  router.post(
    '/:id([0-9a-fA-F-]{36})/disposition-verifications/:verificationId([0-9a-fA-F-]{36})/cancel',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const organizationId = await getOrgId(req);
        const cancelledByUserId = req.user?.id;
        if (!cancelledByUserId) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            message: 'Not authenticated',
          });
        }
        const result = await dispositionVerificationService.cancel({
          organizationId,
          findingId: req.params.id,
          verificationId: req.params.verificationId,
          cancelledByUserId,
        });
        if (result.runId) {
          await cancelVerificationRuns(organizationId, [result.runId], 'findings.disposition_verifications.cancel');
        }
        res.json({ verification: result.verification });
      } catch (error) {
        sendDispositionError(res, error, '[findings] Failed to cancel disposition verification');
      }
    },
  );

  async function launchFindingLifecycleRun(req: Request, res: Response, mode: FindingLifecycleMode): Promise<void> {
    try {
      if (!startRunService) {
        sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is not available on this node',
        });
        return;
      }

      const workersEnabled = deps.enableWorkers ?? true;
      const appRole = deps.appRole ?? 'api';
      if (!workersEnabled && appRole !== 'worker') {
        sendApiError(res, {
          code: ERROR_CODES.INTERNAL_CONFIGURATION,
          message: 'Run execution is disabled on API-only nodes',
        });
        return;
      }

      const userId = req.user?.id;
      if (!userId) {
        sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
        return;
      }

      const orgId = await getOrgId(req);
      const findingId = req.params.id;
      if (!findingId) {
        sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'Finding id is required',
        });
        return;
      }

      const findingRow = await getFindingOwned(orgId, findingId);
      if (!findingRow) {
        sendApiError(res, {
          code: ERROR_CODES.RESOURCE_NOT_FOUND,
          message: 'Finding not found',
        });
        return;
      }
      if (!findingRow.scopeId) {
        sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'Finding is not linked to a scope',
        });
        return;
      }

      const runGoal =
        mode === 'validate'
          ? `Validate finding: ${findingRow.title}`
          : `Retest finding remediation: ${findingRow.title}`;
      const scopeContext = await scopeService.getScopeContext(findingRow.scopeId);

      const verifiedTargets = scopeContext.targets.filter((t) => t.verified);
      const domainTargets = verifiedTargets.filter((t) => t.type === 'domain').map((t) => t.value);
      const cidrTargets = verifiedTargets.filter((t) => t.type === 'cidr').map((t) => t.value);
      const allTargetValues = verifiedTargets.map((t) => t.value);
      const scopeVars: Record<string, unknown> = {
        seed_domains: domainTargets.join(', ') || cidrTargets.join(', '),
        include_subdomains: domainTargets.length > 0,
        scope_allowlist: allTargetValues.join(', '),
        scope_blocklist: '',
        scan_depth: 'standard',
        rate_limit_rps: 5,
        include_ports: true,
      };

      const lifecycleVars: Record<string, unknown> = {
        findingId: findingRow.id,
        finding_id: findingRow.id,
        finding_title: findingRow.title,
        finding_summary: findingRow.summary,
        finding_severity: findingRow.severity,
        finding_asset_id: findingRow.assetId,
      };

      const reqBody = (req.body ?? {}) as { vars?: Record<string, unknown> };
      const mergedVars = {
        ...scopeVars,
        ...lifecycleVars,
        ...(reqBody.vars ?? {}),
      };
      const subscription = await accessControl.enforceRunCreation({
        userId,
        organizationId: orgId,
        activeRunCount: await runService.countPlanConcurrentRuns(orgId),
        deferConcurrencyToAdmission: startRunService.usesQueuedCloudAdmission('cloud'),
      });
      const startResult = await startRunService.startPlannerRun({
        orgId,
        userId,
        scopeId: findingRow.scopeId,
        goal: runGoal,
        trigger: 'manual',
        vars: mergedVars,
        toolPolicy: PLANNER_TOOL_POLICY,
        idempotency: 'disabled',
        securityOpsFlags: {
          findingId: findingRow.id,
          findingLifecycleMode: mode,
        },
        maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
        schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      });
      const run = startResult.run;

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: mode === 'validate' ? 'finding.validate_triggered' : 'finding.retest_triggered',
          resourceType: 'finding',
          resourceId: findingRow.id,
          changes: {
            after: {
              runId: run.id,
              sessionId: startResult.sessionId,
              scopeId: findingRow.scopeId,
              goal: runGoal,
              lifecycleMode: mode,
              runStatus: run.status,
              runnerId: startResult.runner?.id ?? null,
            },
          },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.error(
          { err: auditErr, findingId: findingRow.id, mode, runId: run.id },
          '[findings] Failed to write audit log for lifecycle trigger',
        );
      }

      await db.insert(runEvents).values({
        runId: run.id,
        type: mode === 'validate' ? 'finding_validate_started' : 'finding_retest_started',
        note: encodeFindingLifecycleRunNote({ findingId: findingRow.id }),
      });

      const now = new Date();
      const runRef = typeof run.displayId === 'number' ? `#r${run.displayId}` : run.id;
      if (
        mode === 'validate' &&
        findingRow.state !== 'confirmed' &&
        findingRow.state !== 'verifying'
      ) {
        await db
          .update(findings)
          .set({
            state: 'verifying',
            lifecycleVersion: findingRow.lifecycleVersion + 1,
            updatedAt: now,
          })
          .where(eq(findings.id, findingRow.id));

        await db.insert(findingEvents).values({
          organizationId: orgId,
          userId,
          findingId: findingRow.id,
          type: 'state_changed',
          fromState: findingRow.state,
          toState: 'verifying',
          note: `Validation run ${runRef} moved Risk to verifying`,
          createdAt: now,
        });
      }

      await db.insert(findingEvents).values({
        organizationId: orgId,
        userId,
        findingId: findingRow.id,
        type: mode === 'validate' ? 'validation_run_started' : 'retest_run_started',
        note: `${mode === 'validate' ? 'Validation' : 'Retest'} run ${runRef} started`,
        createdAt: now,
      });

      const queued = run.status === 'queued';
      res.status(queued ? 202 : 201).json({
        run: {
          ...withRunUiFlags(run),
          runnerName: customerRunnerName(run, startResult.runnerName),
        },
        sessionId: startResult.sessionId,
        policySlug: startResult.policySlug,
        runner: run.executionTarget === 'cloud' ? null : startResult.runner,
        scheduling: schedulingProjection(run),
      });
    } catch (error) {
      const err = toAppError(error);
      logger.error({ err, findingId: req.params.id, mode }, '[findings] Failed to start lifecycle run');
      if (err.httpStatus >= 400 && err.httpStatus < 500) {
        sendApiError(res, {
          code: err.code,
          message: err.message,
          status: err.httpStatus,
        });
        return;
      }
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Failed to start lifecycle run',
      });
    }
  }

  // POST /api/app/findings/:id/validate — start a targeted validation run
  router.post(
    '/:id([0-9a-fA-F-]{36})/validate',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      await launchFindingLifecycleRun(req, res, 'validate');
    },
  );

  // PATCH /api/app/findings/:id — update lifecycle metadata fields
  router.patch(
    '/:id([0-9a-fA-F-]{36})',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const userId = req.user?.id;
        if (!userId) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            message: 'Not authenticated',
          });
        }

        const findingRow = await getFindingOwned(orgId, req.params.id);
        if (!findingRow) {
          return sendApiError(res, {
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Finding not found',
          });
        }

        const {
          businessImpact,
          technicalAnalysis,
          pocDescription,
          pocScriptCode,
          assumptions,
          fixEffort,
          remediation,
          cweId,
          cveId,
          state,
        } = req.body as {
          businessImpact?: string | null;
          technicalAnalysis?: string | null;
          pocDescription?: string | null;
          pocScriptCode?: string | null;
          assumptions?: string | null;
          fixEffort?: string | null;
          remediation?: string | null;
          cweId?: string | null;
          cveId?: string | null;
          state?: RiskState;
        };

        if (state !== undefined && !OPERATOR_EDITABLE_RISK_STATES.has(state)) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'state must be confirmed or accepted; use validation or disposition verification for other states',
          });
        }
        if (state !== undefined && !isDirectRiskStateTransitionAllowed(findingRow.state, state)) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            message: 'Only a confirmed Risk can be accepted, and only an accepted Risk can return to confirmed',
          });
        }
        if (fixEffort !== undefined && fixEffort !== null && !ALLOWED_FIX_EFFORT.has(fixEffort as FindingFixEffort)) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'Invalid fixEffort',
          });
        }
        const nextState = state ?? findingRow.state;

        const now = new Date();
        const [updated] = await db
          .update(findings)
          .set({
            ...(businessImpact !== undefined && {
              businessImpact: businessImpact?.trim() || null,
            }),
            ...(technicalAnalysis !== undefined && {
              technicalAnalysis: technicalAnalysis?.trim() || null,
            }),
            ...(pocDescription !== undefined && {
              pocDescription: pocDescription?.trim() || null,
            }),
            ...(pocScriptCode !== undefined && {
              pocScriptCode: pocScriptCode?.trim() || null,
            }),
            ...(assumptions !== undefined && {
              assumptions: assumptions?.trim() || null,
            }),
            ...(fixEffort !== undefined && {
              fixEffort: fixEffort?.trim() || null,
            }),
            ...(remediation !== undefined && {
              remediation: remediation?.trim() || null,
            }),
            ...(cweId !== undefined && { cweId: cweId?.trim() || null }),
            ...(cveId !== undefined && { cveId: cveId?.trim() || null }),
            ...(nextState !== findingRow.state && {
              state: nextState,
              lifecycleVersion: findingRow.lifecycleVersion + 1,
            }),
            updatedAt: now,
          })
          .where(eq(findings.id, findingRow.id))
          .returning();

        if (!updated) {
          return sendApiError(res, {
            code: ERROR_CODES.INTERNAL_UNEXPECTED,
            message: 'Failed to update finding',
          });
        }

        if (nextState !== findingRow.state) {
          await db.insert(findingEvents).values({
            organizationId: orgId,
            userId,
            findingId: findingRow.id,
            type: 'state_changed',
            fromState: findingRow.state,
            toState: nextState,
            note: 'Risk state updated by operator',
            createdAt: now,
          });

          const stateChangePayload = {
            findingId: findingRow.id,
            fromState: findingRow.state,
            toState: nextState,
          };
          try {
            await automationService.evaluateEvent(orgId, {
              type: 'risk_state_changed',
              payload: stateChangePayload,
            });
          } catch (eventError) {
            const eventErr = toAppError(eventError);
            logger.error(
              { err: eventErr, findingId: findingRow.id },
              '[findings] Risk-state automation hook failed',
            );
            await failedEventService.recordFailure({
              organizationId: orgId,
              eventType: 'automation.evaluate_event',
              payload: {
                channel: 'automation',
                source: 'risks.state_change',
                eventType: 'risk_state_changed',
                eventPayload: stateChangePayload,
              },
              error: eventErr,
            });
          }
        }

        if (
          businessImpact !== undefined ||
          technicalAnalysis !== undefined ||
          pocDescription !== undefined ||
          pocScriptCode !== undefined ||
          assumptions !== undefined ||
          fixEffort !== undefined ||
          remediation !== undefined ||
          cweId !== undefined ||
          cveId !== undefined
        ) {
          await db.insert(findingEvents).values({
            organizationId: orgId,
            userId,
            findingId: findingRow.id,
            type: 'metadata_updated',
            note: 'Finding metadata updated',
            createdAt: now,
          });
        }

        if (nextState !== findingRow.state) {
          const supersededRunIds = await dispositionVerificationService.supersedeActive({
            organizationId: orgId,
            findingId: findingRow.id,
            userId,
            reason: 'Canonical finding lifecycle changed by operator',
          });
          await cancelVerificationRuns(orgId, supersededRunIds, 'findings.patch.lifecycle_change');
        }

        const detail = await mapFindingDetail(orgId, findingRow.id);
        res.json(detail);
      } catch (error) {
        sendDispositionError(res, error, '[findings] Failed to patch finding');
      }
    },
  );

  // PUT /api/app/findings/:id/assign — assign finding to org member
  router.put(
    '/:id([0-9a-fA-F-]{36})/assign',
    requireFindingOrgContext(),
    requireCapability('findings.triage'),
    async (req, res) => {
      try {
        const orgId = await getOrgId(req);
        const userId = req.user?.id;
        if (!userId) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            message: 'Not authenticated',
          });
        }

        const findingRow = await getFindingOwned(orgId, req.params.id);
        if (!findingRow) {
          return sendApiError(res, {
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            message: 'Finding not found',
          });
        }

        const { userId: assigneeUserId } = req.body as {
          userId?: string | null;
        };
        if (assigneeUserId) {
          const [member] = await db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, assigneeUserId)))
            .limit(1);
          if (!member) {
            return sendApiError(res, {
              code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
              message: 'Assignee must be an organization member',
            });
          }
        }

        const now = new Date();
        await db
          .update(findings)
          .set({
            assignedTo: assigneeUserId ?? null,
            updatedAt: now,
          })
          .where(eq(findings.id, findingRow.id));

        await db.insert(findingEvents).values({
          organizationId: orgId,
          userId,
          findingId: findingRow.id,
          type: 'assigned',
          note: assigneeUserId ? `Assigned to ${assigneeUserId}` : 'Assignment cleared',
          createdAt: now,
        });

        const detail = await mapFindingDetail(orgId, findingRow.id);
        res.json(detail);
      } catch (error) {
        const err = toAppError(error);
        logger.error({ err }, '[findings] Failed to assign finding');
        sendApiError(res, {
          code: ERROR_CODES.INTERNAL_UNEXPECTED,
          message: 'Failed to assign finding',
        });
      }
    },
  );

  // POST /api/app/findings/bulk — bulk lifecycle actions
  router.post('/bulk', requirePrimaryOrgContext, requireCapability('findings.manage'), async (req, res) => {
    try {
      const orgId = await getOrgId(req);
      const userId = req.user?.id;
      if (!userId) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
          message: 'Not authenticated',
        });
      }

      const { findingIds, action, params } = req.body as {
        findingIds?: string[];
        action?: BulkAction;
        params?: Record<string, unknown>;
      };

      if (!Array.isArray(findingIds) || findingIds.length === 0 || !action) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'findingIds and action are required',
        });
      }
      const uniqueFindingIds = Array.from(new Set(findingIds.filter((id): id is string => typeof id === 'string')));
      if (uniqueFindingIds.length === 0) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_MISSING_REQUIRED,
          message: 'findingIds must contain at least one valid ID',
        });
      }

      if (uniqueFindingIds.length > MAX_BULK_IDS) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
          message: `Bulk action supports up to ${MAX_BULK_IDS} finding IDs per request`,
        });
      }
      if (uniqueFindingIds.some((id) => !UUID_RE.test(id))) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'findingIds must contain valid UUID values',
        });
      }

      if (!['assign', 'set_state'].includes(action)) {
        return sendApiError(res, {
          code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
          message: 'Invalid bulk action',
        });
      }

      const rows = await db
        .select()
        .from(findings)
        .where(and(eq(findings.organizationId, orgId), inArray(findings.id, uniqueFindingIds)));

      if (rows.length === 0) {
        return res.json({ updatedCount: 0 });
      }

      const now = new Date();
      let updatedCount = 0;
      const stateChangeEvents: Array<{
        findingId: string;
        title: string;
        fromState: RiskState;
        toState: RiskState;
      }> = [];
      let assignee: string | null = null;
      let stateToApply: RiskState | undefined;
      const lifecycleChangedFindingIds = new Set<string>();

      if (action === 'assign') {
        assignee = (params?.userId as string | null | undefined) ?? null;

        if (assignee) {
          const [member] = await db
            .select({ userId: organizationMembers.userId })
            .from(organizationMembers)
            .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, assignee)))
            .limit(1);
          if (!member) {
            return sendApiError(res, {
              code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
              message: 'Assignee must be an organization member',
            });
          }
        }
      }

      if (action === 'set_state') {
        const state = params?.state as RiskState | undefined;
        if (!state || !OPERATOR_EDITABLE_RISK_STATES.has(state)) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_INVALID_FORMAT,
            message: 'set_state supports confirmed or accepted; use individual proof-based verification for resolved or dismissed',
          });
        }
        const invalidTransition = rows.find((row) => !isDirectRiskStateTransitionAllowed(row.state, state));
        if (invalidTransition) {
          return sendApiError(res, {
            code: ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED,
            message: `Risk ${invalidTransition.id} cannot move from ${invalidTransition.state} to ${state}`,
          });
        }
        stateToApply = state;
      }

      await db.transaction(async (tx) => {
        if (action === 'assign') {
          for (const findingRow of rows) {
            await tx
              .update(findings)
              .set({
                assignedTo: assignee,
                updatedAt: now,
              })
              .where(eq(findings.id, findingRow.id));
            await tx.insert(findingEvents).values({
              organizationId: orgId,
              userId,
              findingId: findingRow.id,
              type: 'assigned',
              note: assignee ? `Assigned to ${assignee}` : 'Assignment cleared',
              createdAt: now,
            });
            updatedCount += 1;
          }
          return;
        }

        if (action === 'set_state') {
          for (const findingRow of rows) {
            if (!stateToApply || findingRow.state === stateToApply) continue;
            await tx
              .update(findings)
              .set({
                state: stateToApply,
                lifecycleVersion: findingRow.lifecycleVersion + 1,
                updatedAt: now,
              })
              .where(eq(findings.id, findingRow.id));
            await tx.insert(findingEvents).values({
              organizationId: orgId,
              userId,
              findingId: findingRow.id,
              type: 'state_changed',
              fromState: findingRow.state,
              toState: stateToApply,
              note: 'Risk state updated via bulk action',
              createdAt: now,
            });
            stateChangeEvents.push({
              findingId: findingRow.id,
              title: findingRow.title,
              fromState: findingRow.state,
              toState: stateToApply,
            });
            lifecycleChangedFindingIds.add(findingRow.id);
            updatedCount += 1;
          }
          return;
        }

      });

      if (action === 'set_state' && stateToApply !== undefined) {
        const supersededRunIds: string[] = [];
        for (const findingRow of rows) {
          if (!lifecycleChangedFindingIds.has(findingRow.id)) continue;
          supersededRunIds.push(
            ...(await dispositionVerificationService.supersedeActive({
              organizationId: orgId,
              findingId: findingRow.id,
              userId,
              reason: 'Canonical finding lifecycle changed via bulk action',
            })),
          );
        }
        await cancelVerificationRuns(orgId, supersededRunIds, 'findings.bulk.lifecycle_change');
      }

      for (const event of stateChangeEvents) {
        const stateChangePayload = {
          findingId: event.findingId,
          fromState: event.fromState,
          toState: event.toState,
        };
        try {
          await automationService.evaluateEvent(orgId, {
            type: 'risk_state_changed',
            payload: stateChangePayload,
          });
        } catch (eventError) {
          const eventErr = toAppError(eventError);
          logger.error(
            { err: eventErr, findingId: event.findingId },
            '[findings] Bulk Risk-state automation hook failed',
          );
          await failedEventService.recordFailure({
            organizationId: orgId,
            eventType: 'automation.evaluate_event',
            payload: {
              channel: 'automation',
              source: 'risks.bulk_state_change',
              eventType: 'risk_state_changed',
              eventPayload: stateChangePayload,
            },
            error: eventErr,
          });
        }
      }

      try {
        await auditService.log({
          organizationId: orgId,
          actorId: userId,
          actorType: 'user',
          action: 'finding.bulk_updated',
          resourceType: 'finding',
          changes: {
            after: {
              action,
              updatedCount,
              requestedCount: uniqueFindingIds.length,
              params: params ?? null,
            },
          },
          metadata: buildAuditMetadata(req),
        });
      } catch (auditError) {
        const auditErr = toAppError(auditError);
        logger.error({ err: auditErr, action }, '[findings] Failed to write audit log for bulk action');
      }

      res.json({ updatedCount });
    } catch (error) {
      sendDispositionError(res, error, '[findings] Failed to run bulk action');
    }
  });

  return router;
}
