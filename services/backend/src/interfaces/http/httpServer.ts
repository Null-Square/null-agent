import express, { type Application } from 'express';
import cors from 'cors';
import { createLocalHostOnly } from '@/interfaces/http/middleware/localHostOnly';
import { ensurePrimaryOrgContext } from '@/interfaces/http/middleware/orgContext';
import { appUrl, loadOrCreateOwnerKey } from '@/shared/auth/ownerKey';
import path from 'path';
import { createAgentRouter } from './controllers/ai-agent/AgentRouter';
import { authMiddleware } from '@/shared/middleware/auth.middleware';
import { requestIdMiddleware } from '@/shared/middleware/requestId';
import { createAuthRouter } from './controllers/auth';
import { createProfileRouter } from './controllers/profile';
import { createNotificationsRouter } from '@/interfaces/http/controllers/notifications.router';
import { createOrganizationRouter } from '@/interfaces/http/controllers/organization.router';
import { createChatGptCallbackRouter, createModelRouter } from '@/interfaces/http/controllers/model.router';
import { createDefaultModelProbe } from '@/app/services/platform/models/modelProbe';
import { ChatGptSignIn, loopbackRedirectUri } from '@/app/services/platform/models/chatGptSignIn';
import { createScopesRouter } from '@/interfaces/http/controllers/scopes.router';
import { createRunsRouter } from '@/interfaces/http/controllers/runs.router';
import { createFindingsRouter } from '@/interfaces/http/controllers/findings.router';
import { createRisksRouter } from '@/interfaces/http/controllers/risks.router';
import { createAssetsRouter } from '@/interfaces/http/controllers/assets.router';
import { createExposureRouter } from '@/interfaces/http/controllers/exposure.router';
import { CVE_VERIFICATION_TOOL_POLICY } from '@/domains/security-ops/runs/StartRunPromptHelpers';
import { createDashboardRouter } from '@/interfaces/http/controllers/dashboard.router';
import { createComplianceRouter } from '@/interfaces/http/controllers/compliance.router';
import { createChatRouter } from '@/interfaces/http/controllers/chat.router';
import { createRunnersRouter } from '@/interfaces/http/controllers/runners.router';
import { createRunnerAgentRouter } from '@/interfaces/http/controllers/runner-agent.router';
import { createAutomationsRouter } from '@/interfaces/http/controllers/automations.router';
import { createAttentionRouter } from '@/interfaces/http/controllers/attention.router';
import { createAuditLogsRouter } from '@/interfaces/http/controllers/audit-logs.router';
import { createContextSetupRouter } from '@/interfaces/http/controllers/context-setup.router';
import {
  securityOpsAuditService,
  securityOpsOrganizationService,
} from '@/domains/security-ops/audit/securityOpsServices';
import type { AppContext } from '@/app/createAppContext';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { registry as prometheusRegistry, s3HealthGauge, dbHealthGauge } from '@/shared/metrics/prometheusMetrics';
import { logger } from '@/shared/logger';
import swaggerUi from 'swagger-ui-express';
import { generateOpenAPIDocument } from '@/shared/openapi';
import { checkDependencies as checkDependencyHealth } from '@/app/services/health/dependencyHealth';
import { toAppError, getErrorMessage, ErrorSerializer } from '@/shared/errors';
import { RATE_LIMIT_WINDOW_MS } from '@/config/timeouts';
import { createApiTrafficClassLimiters } from '@/shared/ratelimit';
import { sendApiError, ERROR_CODES, configureApiError } from '@/shared/errors';
import { createPlatformKernel } from '@/app/platform/kernel';

export const createHttpApp = (appContext: AppContext): Application => {
  const app: Application = express();

  // Trust the first hop reverse proxy (Caddy in production).
  // Without this, Express ignores X-Forwarded-Proto / X-Forwarded-For and
  // req.protocol is always 'http' even when the client used HTTPS, causing
  // the runner HTTPS guard to fire with a 400 in production.
  app.set('trust proxy', 1);

  const config = appContext.config;
  if (!config) {
    throw new Error('AppContext is missing resolved configuration');
  }
  const isDev = Boolean(appContext.isDev);
  app.locals.config = config;
  app.locals.isDev = isDev;
  // The one secret that makes a request the person (shared/auth/ownerKey.ts).
  app.locals.ownerKey = loadOrCreateOwnerKey();
  configureApiError({ isDev });

  const platformKernel = createPlatformKernel();
  // Sign in with ChatGPT returns through the app (it proxies /auth/callback here) on the loopback
  // address the docs require, then the browser goes back to the app.
  const chatGptSignIn = new ChatGptSignIn({ models: platformKernel.models });
  const chatGptRedirectUri = loopbackRedirectUri(appUrl());

  const checkDependencies = () =>
    checkDependencyHealth({
      s3ArtifactsClient: appContext.s3ArtifactsClient,
      s3ArtifactsBucket: appContext.s3ArtifactsBucket,
      s3TracesClient: appContext.s3TracesClient,
      s3TracesBucket: appContext.s3TracesBucket,
      s3WorkspacesClient: appContext.s3WorkspacesClient,
      s3WorkspacesBucket: appContext.s3WorkspacesBucket,
    });

  const isSandboxStatusHealthy = (value: unknown): boolean => {
    if (typeof value === 'object' && value !== null && 'healthy' in value) {
      const healthy = (value as { healthy?: boolean }).healthy;
      return healthy !== false;
    }
    return value !== 'error';
  };

  const allowedOrigins = [...config.network.corsAllowedOrigins];
  const normalizeOrigin = (value: string): string => {
    if (value === '*') {
      return value;
    }
    return value.replace(/\/+$/, '');
  };

  const normalizedOrigins: string[] = allowedOrigins
    .map((origin: string) => origin.trim())
    .map((origin: string) => normalizeOrigin(origin))
    .filter((origin: string) => origin.length > 0);

  const normalizeHostPattern = (value: string): string => value.trim().toLowerCase();
  const toHostname = (origin: string): string | null => {
    try {
      return new URL(origin).hostname.toLowerCase();
    } catch {
      return null;
    }
  };

  const allowAllOrigins = normalizedOrigins.includes('*');
  const hasConfiguredOrigins = normalizedOrigins.length > 0;
  const originPatterns = normalizedOrigins.filter((origin) => origin === '*' || origin.includes('://'));
  const hostPatterns = normalizedOrigins.filter((origin) => origin !== '*' && !origin.includes('://'));

  const exactOrigins = new Set(originPatterns.filter((origin) => origin !== '*' && !origin.includes('*')));

  const wildcardRegexes = originPatterns
    .filter((origin) => origin.includes('*') && origin !== '*')
    .map((origin: string) => {
      const escaped = origin
        .split('*')
        .map((segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      return new RegExp(`^${escaped}$`);
    });

  const exactHosts = new Set(
    hostPatterns.filter((pattern) => !pattern.includes('*')).map((pattern) => normalizeHostPattern(pattern)),
  );

  const wildcardHostMatchers = hostPatterns
    .filter((pattern) => pattern.includes('*'))
    .map((pattern) => {
      const normalizedPattern = normalizeHostPattern(pattern);
      if (normalizedPattern.startsWith('*.') && !normalizedPattern.slice(2).includes('*')) {
        const base = normalizedPattern.slice(2);
        return (hostname: string) => hostname === base || hostname.endsWith(`.${base}`);
      }
      const escaped = normalizedPattern
        .split('*')
        .map((segment: string) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${escaped}$`);
      return (hostname: string) => regex.test(hostname);
    });

  const credentialsEnabled = true;

  const matchesAllowedOrigin = (origin: string): boolean => {
    const normalizedOrigin = normalizeOrigin(origin);

    if (exactOrigins.has(normalizedOrigin)) {
      return true;
    }

    if (wildcardRegexes.some((regex) => regex.test(normalizedOrigin))) {
      return true;
    }

    const hostname = toHostname(normalizedOrigin);
    if (hostname) {
      if (exactHosts.has(hostname)) {
        return true;
      }
      if (wildcardHostMatchers.some((matcher) => matcher(hostname))) {
        return true;
      }
    }

    return false;
  };

  const corsOptions: cors.CorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) {
        return callback(null, true);
      }

      if (!hasConfiguredOrigins) {
        return callback(null, true);
      }

      if (!credentialsEnabled && allowAllOrigins) {
        return callback(null, true);
      }

      if (matchesAllowedOrigin(origin)) {
        return callback(null, true);
      }

      logger.warn({ origin }, 'CORS blocked origin');
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: credentialsEnabled,
  };

  // tighten CORS: warn and block wildcard with credentials
  if (allowAllOrigins && credentialsEnabled) {
    logger.warn('Wildcard origins are not allowed with credentials. Blocking by default.');
  }

  // No sign-in, so the first door is the host: only requests addressed to this computer (localHostOnly).
  app.use(createLocalHostOnly());
  app.use(requestIdMiddleware({ config }));

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  const traceLogsPath = path.resolve(process.cwd(), config.trace.traceLogsRoot);
  app.use(
    '/logs/ai-agent',
    authMiddleware,
    express.static(traceLogsPath, {
      fallthrough: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.ndjson')) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline');
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Legacy /v1 scans endpoint: return 410 with tombstone message for clients
  app.get('/api/scans', (_req, res) => {
    sendApiError(res, {
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'scans_archived',
      status: 410,
    });
  });
  // Legacy /v1 routes removed - use /api/ai-agent instead

  // One limiter per traffic class, each with its own bucket namespace so the
  // agent API and the user-facing app cannot drain each other's budget. Mount each of these on exactly one path per request — see
  // the /api/app gate below for why.
  const trafficLimits = createApiTrafficClassLimiters();
  // Gate each route tree exactly once, at its root, on its own app.use().
  //
  // Express runs every middleware whose mount path prefixes the request, so a
  // limiter attached to both '/api/app' and '/api/app/scopes' counts a single
  // scopes request twice and silently halves the budget for that tree. Keep the
  // gate separate from the router mounts so sub-mounts can be added below
  // without re-introducing that. Guarded by the "exactly once" cases in
  // tests/integration/api-gateway/rate-limit.contract.test.ts.
  app.use('/api/auth', trafficLimits.auth);
  app.use('/api/auth', createAuthRouter());
  // Not under /api: ChatGPT's redirect is a browser navigation that carries no owner key; the
  // attempt's one-time state admits it (model.router.ts).
  app.use('/auth/callback', trafficLimits.auth, createChatGptCallbackRouter(chatGptSignIn));

  app.use(
    '/api/profile',
    trafficLimits.authenticatedIngress,
    authMiddleware,
    trafficLimits.interactiveUser,
    createProfileRouter(platformKernel),
  );
  app.use(
    '/api/notifications',
    trafficLimits.authenticatedIngress,
    authMiddleware,
    trafficLimits.interactiveUser,
    createNotificationsRouter(platformKernel),
  );
  // Authenticate once, apply a high per-IP abuse ceiling, then enforce the
  // normal application budget per user. Nested routers retain their auth
  // middleware for standalone composition, but authMiddleware short-circuits
  // once this boundary has populated req.user.
  // A private runner proves itself with its own runner token (runnerTokenAuth), not the owner key,
  // so its routes answer before the owner's /api/app boundary.
  app.use('/api/app/runner-agent', createRunnerAgentRouter());
  app.use(
    '/api/app',
    trafficLimits.authenticatedIngress,
    authMiddleware,
    trafficLimits.interactiveUser,
    ensurePrimaryOrgContext,
  );
  app.use('/api/app/organization', authMiddleware, createOrganizationRouter());
  app.use(
    '/api/app/model',
    authMiddleware,
    createModelRouter({
      models: platformKernel.models,
      probe: createDefaultModelProbe(config),
      chatGpt: chatGptSignIn,
      chatGptRedirectUri,
      appUrl: appUrl(),
    }),
  );
  app.use('/api/app/scopes', authMiddleware, createScopesRouter());

  // Mounted at the /api/app root: one endpoint the sidebar calls on every page.
  app.use('/api/app', createAttentionRouter({ orgService: securityOpsOrganizationService }));

  // SecurityOps app routes (Phase 2)
  app.use('/api/app/context-setup', authMiddleware, createContextSetupRouter({ config }));
  app.use(
    '/api/app/runs',
    authMiddleware,
    createRunsRouter({
      services: appContext.agentServices,
      traceRoot: config.trace.traceLogsRoot,
      s3TracesClient: appContext.s3TracesClient,
      appRole: appContext.appRole,
      enableWorkers: appContext.enableWorkers,
      config,
    }),
  );
  app.use(
    '/api/app/findings',
    authMiddleware,
    createFindingsRouter({
      services: appContext.agentServices,
      appRole: appContext.appRole,
      enableWorkers: appContext.enableWorkers,
    }),
  );
  app.use(
    '/api/app/risks',
    authMiddleware,
    createRisksRouter({
      accessControl: platformKernel.accessControl,
    }),
  );
  app.use('/api/app/assets', authMiddleware, createAssetsRouter());
  app.use(
    '/api/app/exposure',
    authMiddleware,
    createExposureRouter({
      accessControl: platformKernel.accessControl,
      // Absent on nodes without workers, which the router surfaces as
      // "verification is not available here" rather than failing deeper.
      startVerificationRun: appContext.startRunService
        ? async ({ organizationId, userId, scopeId, goal, vars, executionSelection }) => {
            const result = await appContext.startRunService!.startPlannerRun({
              orgId: organizationId,
              userId,
              scopeId,
              goal,
              trigger: 'exposure_verification',
              toolPolicy: CVE_VERIFICATION_TOOL_POLICY,
              // Verification answers one question about one asset; deduplicating
              // against an earlier run would silently return a stale verdict.
              idempotency: 'disabled',
              vars,
              executionSelection,
            });
            return { runId: result.run.id };
          }
        : undefined,
    }),
  );
  app.use('/api/app/dashboard', authMiddleware, createDashboardRouter());
  app.use('/api/app/compliance', authMiddleware, createComplianceRouter());
  app.use(
    '/api/app/chat',
    authMiddleware,
    createChatRouter({
      services: appContext.agentServices,
      appRole: appContext.appRole,
      enableWorkers: appContext.enableWorkers,
    }),
  );
  app.use('/api/app/runners', authMiddleware, createRunnersRouter());
  app.use(
    '/api/app/automations',
    authMiddleware,
    createAutomationsRouter({
      services: appContext.agentServices,
      appRole: appContext.appRole,
      enableWorkers: appContext.enableWorkers,
    }),
  );
  app.use(
    '/api/app/audit-logs',
    authMiddleware,
    createAuditLogsRouter({
      orgService: securityOpsOrganizationService,
      auditService: securityOpsAuditService,
    }),
  );

  const agentServices = appContext.agentServices;
  // Prometheus metrics exporter using prom-client
  // Exports real histograms with buckets for p50/p95/p99 calculation
  app.get('/metrics', authMiddleware, async (_req, res) => {
    try {
      const { db, s3Artifacts, s3Traces, s3Workspaces } = await checkDependencies();
      dbHealthGauge.set(db.status === 'ok' ? 1 : 0);
      s3HealthGauge.set({ bucket: 'artifacts' }, s3Artifacts.status === 'ok' ? 1 : 0);
      s3HealthGauge.set({ bucket: 'traces' }, s3Traces.status === 'ok' ? 1 : 0);
      s3HealthGauge.set({ bucket: 'workspaces' }, s3Workspaces.status === 'ok' ? 1 : 0);

      // Export all metrics from prom-client registry
      res.setHeader('Content-Type', prometheusRegistry.contentType);
      res.send(await prometheusRegistry.metrics());
    } catch (error) {
      const appErr = toAppError(error);
      logger.error({ err: appErr }, '[metrics] failed to export metrics');
      res.status(500).send('# Error generating metrics');
    }
  });

  const aiAgentRouter = createAgentRouter({
    services: agentServices,
    config,
    appRole: appContext.appRole,
    enableWorkers: appContext.enableWorkers,
    // Named so agent traffic gets its own counter. Left unnamed it shared the
    // bare-IP bucket with defaultRateLimit, and chat usage silently ate the
    // user-facing app's 120/min budget.
    rateLimitOptions: {
      name: 'agent',
      windowMs: RATE_LIMIT_WINDOW_MS,
      max: 300,
    },
  });

  app.use('/api/ai-agent', authMiddleware, ensurePrimaryOrgContext, aiAgentRouter);

  // OpenAPI/Swagger UI
  const openApiSpec = generateOpenAPIDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Null AI API Docs',
      customCss: '.swagger-ui .topbar { display: none }',
      swaggerOptions: {
        persistAuthorization: true,
      },
    }),
  );

  app.get('/health', (_req, res) => {
    const appRole = appContext.appRole ?? 'api';
    const workersEnabled = appContext.enableWorkers ?? false;
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      role: appRole,
      workersEnabled,
    });
  });

  app.get('/health/ready', async (_req, res) => {
    const appRole = appContext.appRole ?? 'api';
    const workersEnabled = appContext.enableWorkers ?? false;
    const status: Record<string, unknown> = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      role: appRole,
      workersEnabled,
    };

    status.redis = 'removed'; // Redis no longer used

    const sandboxHealthy = appContext.sandbox.isHealthy();
    status.sandboxes = {
      manager: Boolean(appContext.sandbox),
      healthy: sandboxHealthy,
    };

    const { db, s3Artifacts, s3Traces, s3Workspaces } = await checkDependencies();
    status.database = db;
    status.s3Artifacts = s3Artifacts;
    status.s3Traces = s3Traces;
    status.s3Workspaces = s3Workspaces;

    let findingDispositionWorkerFailed = false;
    if (appRole === 'worker' && workersEnabled) {
      const findingDispositionWorkerHealth = appContext.findingDispositionWorkerHealth;
      const now = Date.now();
      const startedAt = findingDispositionWorkerHealth?.startedAt
        ? Date.parse(findingDispositionWorkerHealth.startedAt)
        : null;
      const lastSuccessfulSweepAt = findingDispositionWorkerHealth?.lastSuccessfulSweepAt
        ? Date.parse(findingDispositionWorkerHealth.lastSuccessfulSweepAt)
        : null;
      const lastSweepStartedAt = findingDispositionWorkerHealth?.lastSweepStartedAt
        ? Date.parse(findingDispositionWorkerHealth.lastSweepStartedAt)
        : null;
      const withinStartupGrace = startedAt !== null && now - startedAt < 30_000;
      const sweepIsFresh = lastSuccessfulSweepAt !== null && now - lastSuccessfulSweepAt < 45_000;
      const activeSweepIsFresh =
        findingDispositionWorkerHealth?.inFlight && lastSweepStartedAt !== null && now - lastSweepStartedAt < 60_000;
      findingDispositionWorkerFailed = !withinStartupGrace && !sweepIsFresh && !activeSweepIsFresh;
      status.findingDispositionWorker = {
        state: findingDispositionWorkerFailed ? 'degraded' : lastSuccessfulSweepAt === null ? 'starting' : 'healthy',
        ...(findingDispositionWorkerHealth ?? {
          startedAt: null,
          lastSweepStartedAt: null,
          lastSuccessfulSweepAt: null,
          lastErrorAt: null,
          lastError: 'finding disposition worker was not initialized',
          oldestDueAgeMs: null,
          activeQueueDepth: 0,
          inFlight: false,
        }),
      };
    }

    const s3Failures = [s3Artifacts, s3Traces, s3Workspaces].some((entry) => entry.status === 'down');
    const hasFailures =
      sandboxHealthy === false || db.status === 'down' || s3Failures || findingDispositionWorkerFailed;
    res.status(hasFailures ? 503 : 200).json(status);
  });

  app.get('/health/extended', async (_req, res) => {
    const appRole = appContext.appRole ?? 'api';
    const workersEnabled = appContext.enableWorkers ?? false;
    const status: Record<string, unknown> = {
      status: 'OK',
      timestamp: new Date().toISOString(),
      role: appRole,
      workersEnabled,
    };

    status.redis = 'removed'; // Redis no longer used

    // Sandbox manager check
    try {
      const sbStart = Date.now();
      const sandboxHealthy = appContext.sandbox.isHealthy();
      const sandboxes = sandboxHealthy ? await appContext.sandbox.listSandboxes() : [];
      status.sandboxes = {
        count: Array.isArray(sandboxes) ? sandboxes.length : 0,
        healthy: sandboxHealthy,
      };
      opsMetrics.recordSandboxList(Date.now() - sbStart, Array.isArray(sandboxes) ? sandboxes.length : 0);
    } catch (error) {
      const appErr = toAppError(error);
      status.sandboxes = 'error';
      status.sandboxesError = getErrorMessage(appErr);
      opsMetrics.recordSandboxList(0, 0);
    }

    const sandboxHealthy = isSandboxStatusHealthy(status.sandboxes);

    const { db, s3Artifacts, s3Traces, s3Workspaces } = await checkDependencies();
    status.database = db;
    status.s3Artifacts = s3Artifacts;
    status.s3Traces = s3Traces;
    status.s3Workspaces = s3Workspaces;

    const s3Failures = [s3Artifacts, s3Traces, s3Workspaces].some((entry) => entry.status === 'down');
    const hasFailures = !sandboxHealthy || status.sandboxes === 'error' || db.status === 'down' || s3Failures;
    res.status(hasFailures ? 503 : 200).json(status);
  });

  app.use('*', (_req, res) => {
    sendApiError(res, {
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Route not found',
    });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const reqLogger = req.logger ?? logger;
    const appErr = toAppError(error);
    const response = ErrorSerializer.serialize(error, req.requestId ?? res.locals?.requestId, {
      isDev: req.app?.locals?.isDev ?? isDev,
    });
    const status = response.httpStatus;

    if (status >= 500) {
      reqLogger.error({ err: appErr }, 'Unhandled error');
    } else {
      reqLogger.warn({ err: appErr }, 'Request handled with error response');
    }

    if (status === 429 && response.retryAfterMs) {
      res.setHeader('Retry-After', Math.ceil(response.retryAfterMs / 1000).toString());
    }

    res.status(status).json(response);
  });

  return app;
};

export default createHttpApp;
