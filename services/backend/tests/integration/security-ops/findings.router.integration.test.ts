import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

const orgServiceMocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
}));

const scopeServiceMocks = vi.hoisted(() => ({
  getScopeContext: vi.fn(),
}));

const auditServiceMocks = vi.hoisted(() => ({
  log: vi.fn(),
}));

const startRunServiceMocks = vi.hoisted(() => ({
  startPlannerRun: vi.fn(),
  usesQueuedCloudAdmission: vi.fn(),
}));

const runServiceMocks = vi.hoisted(() => ({
  countPlanConcurrentRuns: vi.fn(),
}));

const accessControlMocks = vi.hoisted(() => ({
  enforceRunCreation: vi.fn(),
}));

const organizationContextMocks = vi.hoisted(() => ({
  findFindingOrganizationId: vi.fn(),
  findMembershipRole: vi.fn(),
}));

const dispositionServiceMocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getCompactProjections: vi.fn(),
  request: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  supersedeActive: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: dbMocks,
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: vi.fn(() => orgServiceMocks),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

vi.mock('@/app/platform/kernel', () => ({
  createPlatformKernel: () => ({ accessControl: accessControlMocks }),
}));

vi.mock('@/app/services/platform/organizations/organizationContextAppService', () => ({
  organizationContextAppService: organizationContextMocks,
}));

vi.mock('@/app/services/agent/agentRepositories', () => ({
  createAgentRepositories: () => ({ sessionRepository: {}, policyRepository: {} }),
}));

vi.mock('@/app/adapters/portFactories', () => ({
  createSubscriptionPort: () => ({}),
  createModelConfigPort: () => ({}),
}));

vi.mock('@/domains/security-ops/scopes/ScopeService', () => ({
  ScopeService: vi.fn(() => scopeServiceMocks),
}));

vi.mock('@/domains/security-ops/runners/RunnerService', () => ({
  RunnerService: vi.fn(() => ({})),
}));

vi.mock('@/domains/security-ops/audit/AuditService', () => ({
  AuditService: vi.fn(() => auditServiceMocks),
}));

vi.mock('@/domains/security-ops/resilience/FailedEventService', () => ({
  FailedEventService: vi.fn(() => ({})),
}));

vi.mock('@/domains/security-ops/automations/AutomationService', () => ({
  AutomationService: vi.fn(() => ({})),
}));

vi.mock('@/domains/security-ops/runs/RunService', () => ({
  RunService: vi.fn(() => runServiceMocks),
  encodeFindingLifecycleRunNote: vi.fn(),
  deriveRunDisplayState: vi.fn(({ status }) => ({
    status,
    pauseReason: null,
    interactionType: null,
    awaitingPlanApproval: false,
  })),
}));

vi.mock('@/domains/security-ops/runs/StartRunService', () => ({
  StartRunService: vi.fn(() => startRunServiceMocks),
}));

vi.mock('@/domains/security-ops/findings/FindingDispositionVerificationService', () => ({
  FindingDispositionVerificationService: vi.fn(() => dispositionServiceMocks),
}));

vi.mock('@/domains/agent-brain/application/services/SessionService', () => ({
  SessionService: vi.fn(() => ({})),
}));

import { createFindingsRouter } from '@/interfaces/http/controllers/findings.router';

type QueryRows = Array<Record<string, unknown>>;

const createSelectBuilder = (rows: QueryRows) => {
  const builder = {
    from: () => builder,
    leftJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (value: QueryRows) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };

  return builder;
};

const createMutationBuilder = (result: QueryRows = []) => {
  const where = vi.fn(() => Promise.resolve(result));
  const returning = vi.fn(() => Promise.resolve(result));
  const set = vi.fn(() => ({ where, returning }));
  const values = vi.fn(() => Promise.resolve(result));

  return { set, values, where, returning };
};

describe('findings.router integration', () => {
  const findingId = '123e4567-e89b-42d3-a456-426614174001';
  let mutationBuilders: Array<ReturnType<typeof createMutationBuilder>>;

  const buildApp = (deps: Parameters<typeof createFindingsRouter>[0] = {}) => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/findings', createFindingsRouter(deps));
    return app;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    orgServiceMocks.getForUser.mockResolvedValue({ id: 'org-1' });
    organizationContextMocks.findFindingOrganizationId.mockResolvedValue('org-1');
    organizationContextMocks.findMembershipRole.mockResolvedValue('admin');
    scopeServiceMocks.getScopeContext.mockResolvedValue({
      name: 'Scope One',
      executionNetwork: 'external',
      attachedRunner: null,
      targets: [{ type: 'domain', value: 'app.example.com', verified: true }],
      mission: null,
      stealthPosture: 'coordinated',
      impactTolerance: 'non_destructive',
      rateLimitRps: null,
      blastWindow: null,
      roeDocument: null,
      testingPosture: 'black-box',
      testingPostureReason: 'no source access or credentials attached',
      whiteboxEnabled: false,
      connectedRepoCount: 0,
      connectedRepositories: [],
      accessMaterialCount: 0,
      accessMaterials: [],
    });
    auditServiceMocks.log.mockResolvedValue(undefined);
    runServiceMocks.countPlanConcurrentRuns.mockResolvedValue(0);
    startRunServiceMocks.usesQueuedCloudAdmission.mockReturnValue(true);
    accessControlMocks.enforceRunCreation.mockResolvedValue({
      plan: { slug: 'control', limits: { maxConcurrentRuns: 2 } },
    });
    startRunServiceMocks.startPlannerRun.mockResolvedValue({
      run: {
        id: 'run-1',
        displayId: 14,
        status: 'queued',
        goal: 'Validate finding: Unauthenticated admin surface',
        executionTarget: 'cloud',
        sessionId: null,
        queuedAt: new Date('2026-08-01T12:00:00.000Z'),
      },
      sessionId: null,
      policySlug: 'default',
      runner: null,
      runnerName: null,
    });
    dispositionServiceMocks.getHistory.mockResolvedValue({
      active: null,
      latest: null,
      attempts: [],
    });
    dispositionServiceMocks.getCompactProjections.mockResolvedValue(new Map());
    dispositionServiceMocks.supersedeActive.mockResolvedValue([]);

    mutationBuilders = [];
    dbMocks.update.mockImplementation(() => {
      const builder = createMutationBuilder();
      mutationBuilders.push(builder);
      return { set: builder.set };
    });
    dbMocks.insert.mockImplementation(() => {
      const builder = createMutationBuilder();
      mutationBuilders.push(builder);
      return { values: builder.values };
    });
  });

  it('does not expose the retired finding collection route', async () => {
    const response = await request(buildApp()).get('/api/app/findings');

    expect(response.status).toBe(404);
    expect(dbMocks.select).not.toHaveBeenCalled();
  });

  it('returns normalized finding detail payloads with confidence and evidence count', async () => {
    const selectResults: QueryRows[] = [
      [
        {
          id: findingId,
          title: 'Open redirect with proof',
          severity: 'high',
          state: 'confirmed',
          assignedTo: null,
          assetId: 'asset-1',
          scopeId: 'scope-1',
          endpointId: 'endpoint-1',
          serviceId: 'service-1',
          summary: 'Summary',
          businessImpact: 'Impact',
          remediation: 'Fix it',
          cweId: 'CWE-601',
          cveId: null,
          cweIds: ['CWE-601'],
          cveIds: null,
          owaspCategory: 'A01:2021-Broken Access Control',
          cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N',
          cvssScore: 6.1,
          confidenceScore: 0.85,
          codeLocations: [
            {
              pathKind: 'repository',
              repository: 'acme/api',
              ref: 'main',
              filePath: 'src/auth/login.ts',
              startLine: 10,
              endLine: 18,
              label: 'Auth handler',
              fixBefore: 'return input;',
              fixAfter: 'return sanitize(input);',
            },
          ],
          firstSeenAt: new Date('2026-03-20T00:00:00.000Z'),
          lastSeenAt: new Date('2026-03-21T00:00:00.000Z'),
          createdAt: new Date('2026-03-20T00:00:00.000Z'),
        },
      ],
      [{ value: 'app.example.com', kind: 'domain' }],
      [{ name: 'Scope One' }],
      [
        {
          id: 'evidence-1',
          sessionId: 'session-1',
          kind: 'artifact',
          path: '.artifacts/proof.txt',
          displayPath: '.artifacts/proof.txt',
          label: 'Artifact proof',
          excerpt: 'proof',
          fileMissing: false,
          data: null,
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
        },
        {
          id: 'evidence-2',
          sessionId: null,
          kind: 'http_exchange',
          path: 'http:abc123',
          displayPath: 'POST https://app.example.com/login',
          label: 'Exploit request',
          excerpt: null,
          fileMissing: false,
          data: {
            request: { method: 'POST', url: 'https://app.example.com/login' },
            response: { statusCode: 302 },
          },
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
        },
      ],
      [
        {
          id: 'artifact-1',
          sessionId: 'session-1',
          originalName: '.artifacts/proof.txt',
          filePath: '/tmp/session-1/.artifacts/proof.txt',
        },
      ],
      [{ id: 'endpoint-1', data: { url: 'https://app.example.com/login', method: 'POST' } }],
      [{ id: 'service-1', protocol: 'https', port: 443, serviceName: 'nginx', product: 'nginx', version: '1.25.0' }],
    ];

    dbMocks.select.mockImplementation(() => createSelectBuilder(selectResults.shift() ?? []));

    const response = await request(buildApp()).get(`/api/app/findings/${findingId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: findingId,
      assetValue: 'app.example.com',
      assetKind: 'domain',
      scopeName: 'Scope One',
      endpoint: {
        id: 'endpoint-1',
        url: 'https://app.example.com/login',
        method: 'POST',
      },
      service: {
        id: 'service-1',
        protocol: 'https',
        port: 443,
        serviceName: 'nginx',
        product: 'nginx',
        version: '1.25.0',
      },
      confidence: 0.85,
      evidenceCount: 2,
      codeLocations: [
        expect.objectContaining({
          pathKind: 'repository',
          repository: 'acme/api',
          filePath: 'src/auth/login.ts',
        }),
      ],
      reviewMeta: {
        codeLocationCount: 1,
        copyFixPromptReady: true,
        evidenceSummary: {
          total: 2,
          artifactCount: 1,
          downloadableArtifactCount: 1,
          structuredHttpCount: 1,
          excerptCount: 1,
          fileMissingCount: 0,
        },
      },
    });
  });

  it('returns mixed artifact and structured finding evidence payloads', async () => {
    const selectResults: QueryRows[] = [
      [
        {
          id: findingId,
          organizationId: 'org-1',
        },
      ],
      [
        {
          id: 'evidence-1',
          sessionId: 'session-1',
          kind: 'artifact',
          path: '.artifacts/proof.txt',
          displayPath: '.artifacts/proof.txt',
          label: 'Artifact proof',
          excerpt: 'proof',
          fileMissing: false,
          data: null,
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
        },
        {
          id: 'evidence-2',
          sessionId: null,
          kind: 'http_exchange',
          path: 'http:abc123',
          displayPath: 'POST https://app.example.com/login',
          label: 'Exploit request',
          excerpt: null,
          fileMissing: false,
          data: {
            source: 'browser',
            request: { method: 'POST', url: 'https://app.example.com/login' },
            response: { statusCode: 302 },
          },
          createdAt: new Date('2026-03-21T00:00:00.000Z'),
        },
      ],
      [
        {
          id: 'artifact-1',
          sessionId: 'session-1',
          originalName: '.artifacts/proof.txt',
          filePath: '/tmp/session-1/.artifacts/proof.txt',
        },
      ],
    ];

    dbMocks.select.mockImplementation(() => createSelectBuilder(selectResults.shift() ?? []));

    const response = await request(buildApp()).get(`/api/app/findings/${findingId}/evidence`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'evidence-1',
          kind: 'artifact',
          path: '.artifacts/proof.txt',
          displayPath: '.artifacts/proof.txt',
          downloadPath: '/api/ai-agent/sessions/session-1/artifacts/artifact-1/download',
        }),
        expect.objectContaining({
          id: 'evidence-2',
          kind: 'http_exchange',
          path: 'http:abc123',
          displayPath: 'POST https://app.example.com/login',
          http: {
            source: 'browser',
            request: { method: 'POST', url: 'https://app.example.com/login' },
            response: { statusCode: 302 },
          },
        }),
      ]),
    );
  });

  it('starts a validation run and moves the Risk to verifying', async () => {
    const selectResults: QueryRows[] = [
      [
        {
          id: findingId,
          title: 'Unauthenticated admin surface',
          summary: 'Admin route is reachable without auth.',
          severity: 'high',
          scopeId: 'scope-1',
          assetId: 'asset-1',
          state: 'potential',
          lifecycleVersion: 0,
        },
      ],
    ];

    dbMocks.select.mockImplementation(() => createSelectBuilder(selectResults.shift() ?? []));

    const response = await request(
      buildApp({
        services: {
          sessionStore: {},
          sandboxProfileRegistry: {},
          ports: {},
          agentEngine: {},
          policyResolver: {},
          traceRecorder: {},
          policyFacade: {},
        } as never,
        enableWorkers: true,
      }),
    )
      .post(`/api/app/findings/${findingId}/validate`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(startRunServiceMocks.startPlannerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'Validate finding: Unauthenticated admin surface',
        securityOpsFlags: {
          findingId,
          findingLifecycleMode: 'validate',
        },
      }),
    );

    const updateCall = mutationBuilders.find((builder) => {
      const setCalls = builder.set.mock.calls as unknown[][];
      const firstCall = setCalls[0];
      if (!firstCall || firstCall.length === 0) return false;
      const payload = firstCall[0] as Record<string, unknown>;
      return payload.state === 'verifying';
    });
    expect(updateCall).toBeDefined();
    const updateCalls = updateCall ? (updateCall.set.mock.calls as unknown[][]) : [];
    const updatePayload = updateCalls.length > 0 ? (updateCalls[0]?.[0] as Record<string, unknown>) : null;
    expect(updatePayload).toMatchObject({
      state: 'verifying',
    });
  });

  it('creates and idempotently replays a disposition verification through the public route', async () => {
    const verification = {
      id: '223e4567-e89b-42d3-a456-426614174002',
      findingId,
      requestedState: 'resolved',
      status: 'queued',
    };
    dbMocks.select.mockImplementation(() => createSelectBuilder([{ id: findingId }]));
    dispositionServiceMocks.request.mockResolvedValue({
      verification,
      idempotentReplay: false,
      supersededRunIds: [],
    });
    dispositionServiceMocks.getHistory.mockResolvedValue({
      active: verification,
      latest: verification,
      attempts: [verification],
    });
    const app = buildApp();

    const created = await request(app)
      .post(`/api/app/findings/${findingId}/disposition-verifications`)
      .send({
        requestedState: 'resolved',
        reason: 'The patch is deployed.',
        requestKey: 'resolve-one',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body).toMatchObject({
      verification: { id: verification.id, status: 'queued' },
      idempotentReplay: false,
    });
    expect(dispositionServiceMocks.request).toHaveBeenCalledWith({
      organizationId: 'org-1',
      findingId,
      requestedByUserId: 'user-1',
      requestedState: 'resolved',
      requestKey: 'resolve-one',
      reason: 'The patch is deployed.',
    });

    dispositionServiceMocks.request.mockResolvedValue({
      verification,
      idempotentReplay: true,
      supersededRunIds: [],
    });
    const replay = await request(app)
      .post(`/api/app/findings/${findingId}/disposition-verifications`)
      .send({
        requestedState: 'resolved',
        reason: 'The patch is deployed.',
        requestKey: 'resolve-one',
      });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('wires disposition history, Retry, and Cancel without changing canonical state in the route', async () => {
    const verificationId = '223e4567-e89b-42d3-a456-426614174003';
    const terminal = {
      id: verificationId,
      findingId,
      requestedState: 'resolved',
      status: 'failed',
    };
    const retry = {
      ...terminal,
      id: '223e4567-e89b-42d3-a456-426614174004',
      status: 'queued',
      previousVerificationId: verificationId,
    };
    dbMocks.select.mockImplementation(() => createSelectBuilder([{ id: findingId }]));
    dispositionServiceMocks.getHistory.mockResolvedValue({
      active: null,
      latest: terminal,
      attempts: [terminal],
    });
    dispositionServiceMocks.retry.mockResolvedValue(retry);
    dispositionServiceMocks.cancel.mockResolvedValue({
      verification: { ...retry, status: 'cancelled' },
      runId: null,
    });
    const app = buildApp();

    const history = await request(app)
      .get(`/api/app/findings/${findingId}/disposition-verifications`);
    expect(history.status).toBe(200);
    expect(history.body.latest).toMatchObject({ id: verificationId, status: 'failed' });

    const retried = await request(app)
      .post(`/api/app/findings/${findingId}/disposition-verifications/${verificationId}/retry`)
      .send({ requestKey: 'retry-one' });
    expect(retried.status).toBe(202);
    expect(dispositionServiceMocks.retry).toHaveBeenCalledWith({
      organizationId: 'org-1',
      findingId,
      verificationId,
      requestedByUserId: 'user-1',
      requestKey: 'retry-one',
    });

    const cancelled = await request(app)
      .post(`/api/app/findings/${findingId}/disposition-verifications/${retry.id}/cancel`)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.verification.status).toBe('cancelled');
    expect(dispositionServiceMocks.cancel).toHaveBeenCalledWith({
      organizationId: 'org-1',
      findingId,
      verificationId: retry.id,
      cancelledByUserId: 'user-1',
    });
  });
});
