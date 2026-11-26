import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunsRouter } from '@/interfaces/http/controllers/runs.router';
import { buildCodeReviewManifestHash } from '@/domains/security-ops/runs/codeReviewRunContext';
import type * as RunServiceModule from '@/domains/security-ops/runs/RunService';
import type * as StartRunServiceModule from '@/domains/security-ops/runs/StartRunService';

const mocks = vi.hoisted(() => ({
  startPlannerRun: vi.fn(),
  getForUser: vi.fn(),
  scopeGetById: vi.fn(),
  countPlanConcurrentRuns: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: class {
    getForUser = mocks.getForUser;
  },
}));

vi.mock('@/domains/security-ops/scopes/ScopeService', () => ({
  ScopeService: class {
    getById = mocks.scopeGetById;
  },
}));

vi.mock('@/domains/security-ops/runs/RunService', async (importOriginal) => ({
  ...(await importOriginal<typeof RunServiceModule>()),
  RunService: class {
    countPlanConcurrentRuns = mocks.countPlanConcurrentRuns;
  },
}));

vi.mock('@/domains/security-ops/runs/StartRunService', async (importOriginal) => ({
  ...(await importOriginal<typeof StartRunServiceModule>()),
  StartRunService: class {
    startPlannerRun = mocks.startPlannerRun;
    usesQueuedCloudAdmission = () => false;
  },
}));

vi.mock('@/domains/agent-brain/application/services/SessionService', () => ({
  SessionService: class {},
}));

vi.mock('@/domains/security-ops/audit/AuditService', () => ({
  AuditService: class {
    log = mocks.auditLog;
  },
}));

const SCOPE_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const COMMIT = 'c'.repeat(40);
const FILES = [
  { path: 'README.md', blobSha: 'a'.repeat(40), size: 10 },
  { path: 'src/app.ts', blobSha: 'b'.repeat(40), size: 120 },
];

const readySource = {
  id: SOURCE_ID,
  organizationId: 'org-1',
  scopeId: SCOPE_ID,
  kind: 'git',
  location: 'https://github.com/acme/app.git',
  ref: null,
  reviewBrief: 'Focus on the payment flow.',
  status: 'ready',
  error: null,
  headCommit: COMMIT,
  contentHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const snapshot = {
  installationId: 'local-code-source',
  repositoryId: SOURCE_ID,
  fullName: 'acme/app',
  visibility: 'public' as const,
  defaultBranch: 'main',
  requestedRef: 'main',
  immutableCommitSha: COMMIT,
  files: FILES,
  completeness: 'complete' as const,
  reviewBrief: 'Focus on the payment flow.',
};

const makeApp = () => {
  const codeSourceService = {
    getForScope: vi.fn().mockResolvedValue(readySource),
    resolveCodeReviewRepositorySnapshot: vi.fn().mockResolvedValue(snapshot),
  };
  const accessControl = {
    enforceRunCreation: vi.fn().mockResolvedValue({ plan: { slug: 'local', limits: { maxConcurrentRuns: null } } }),
    enforceCodeReviewAccess: vi.fn().mockResolvedValue(undefined),
    enforceGitHubIntegrationAccess: vi.fn().mockResolvedValue(undefined),
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/app/runs',
    createRunsRouter({
      services: {} as never,
      repositories: { sessionRepository: {}, policyRepository: {} } as never,
      kernel: {} as never,
      accessControl: accessControl as never,
      subscriptionPort: {} as never,
      modelConfigPort: { getModel: vi.fn(), getByModelName: vi.fn() } as never,
      runActivityService: {} as never,
      runPhaseRepository: { listByRunId: vi.fn() },
      workspaceProjectionService: {} as never,
      codeSourceService: codeSourceService as never,
    }),
  );
  return { app, codeSourceService, accessControl };
};

describe('POST /api/app/runs/code-reviews', () => {
  beforeEach(() => {
    mocks.getForUser.mockResolvedValue({ id: 'org-1' });
    mocks.scopeGetById.mockResolvedValue({ scope: { id: SCOPE_ID } });
    mocks.countPlanConcurrentRuns.mockResolvedValue(0);
    mocks.auditLog.mockResolvedValue(undefined);
    mocks.startPlannerRun.mockResolvedValue({
      run: {
        id: '33333333-3333-4333-8333-333333333333',
        scopeId: SCOPE_ID,
        goal: 'review',
        status: 'running',
        executionTarget: 'cloud',
        runnerId: null,
        workflowDiscipline: 'code_review',
        createdAt: new Date('2026-11-26T10:00:00.000Z'),
      },
      sessionId: '44444444-4444-4444-8444-444444444444',
      policySlug: 'network-enabled',
      warnings: [],
      runner: null,
      runnerName: null,
      idempotentReplay: false,
    });
  });

  it("pins the scope's ready code source and starts the read-only Code Review workflow", async () => {
    const { app, codeSourceService } = makeApp();

    const response = await request(app).post('/api/app/runs/code-reviews').send({ scopeId: SCOPE_ID });

    expect(response.status).toBe(201);
    const manifestHash = buildCodeReviewManifestHash({
      immutableCommitSha: COMMIT,
      files: FILES,
      allowedPaths: [],
      excludedPaths: [],
    });
    expect(response.body).toMatchObject({
      run: { id: '33333333-3333-4333-8333-333333333333', executionTarget: 'cloud', runnerId: null, runnerName: null },
      sessionId: '44444444-4444-4444-8444-444444444444',
      policySlug: 'network-enabled',
      warnings: [],
      idempotentReplay: false,
      runner: null,
      scheduling: { state: 'started', reason: null },
      codeReview: {
        repository: 'acme/app',
        immutableCommitSha: COMMIT,
        manifestHash,
        manifestFileCount: 2,
        completeness: 'complete',
      },
    });
    expect(codeSourceService.resolveCodeReviewRepositorySnapshot).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: SCOPE_ID,
      repository: SOURCE_ID,
    });
    expect(mocks.startPlannerRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: SCOPE_ID,
      goal: `Perform a security-focused Code Review of acme/app at immutable commit ${COMMIT}.`,
      executionTarget: 'cloud',
      workflowDiscipline: 'code_review',
      codeReviewOperation: 'repository_review',
      plannerPromptProfile: 'code-review-planner',
      toolPolicy: { allow: ['submit_plan', 'file_read', 'list_code_review_repository_files', 'search_code_review_repository', 'read_connected_repository_file'] },
      codeReviewManifestFiles: FILES,
      codeReviewRepositoryBrief: 'Focus on the payment flow.',
      codeReviewContext: {
        operation: 'repository_review',
        repository: {
          provider: 'local',
          installationId: 'local-code-source',
          repositoryId: SOURCE_ID,
          fullName: 'acme/app',
          visibility: 'public',
          immutableCommitSha: COMMIT,
          requestedRef: 'main',
          defaultBranch: 'main',
        },
        reviewScope: {
          mode: 'repository',
          allowedPaths: [],
          excludedPaths: [],
          contextReadPolicy: 'immutable_manifest_only',
          manifestHash,
          completeness: 'complete',
        },
        policySnapshot: {
          version: 'code-review/v1',
          toolProfile: 'code-review-read-only-v1',
          pathPolicy: 'immutable-manifest-bound',
          networkPolicy: 'local-source-no-network',
          publicationPolicy: 'none',
        },
      },
    }));
  });

  it('refuses a scope with no code source', async () => {
    const { app, codeSourceService } = makeApp();
    codeSourceService.getForScope.mockResolvedValue(null);
    const response = await request(app).post('/api/app/runs/code-reviews').send({ scopeId: SCOPE_ID });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/has no code source/u);
    expect(mocks.startPlannerRun).not.toHaveBeenCalled();
  });

  it('refuses while the code source is still cloning', async () => {
    const { app, codeSourceService } = makeApp();
    codeSourceService.getForScope.mockResolvedValue({ ...readySource, status: 'cloning', headCommit: null });
    const response = await request(app).post('/api/app/runs/code-reviews').send({ scopeId: SCOPE_ID });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/still being cloned/u);
    expect(mocks.startPlannerRun).not.toHaveBeenCalled();
  });

  it('refuses a path policy that selects no files at the pinned commit', async () => {
    const { app } = makeApp();
    const response = await request(app)
      .post('/api/app/runs/code-reviews')
      .send({ scopeId: SCOPE_ID, allowedPaths: ['does-not-exist'] });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/does not include any files/u);
    expect(mocks.startPlannerRun).not.toHaveBeenCalled();
  });

  it('refuses traversal in the path policy', async () => {
    const { app } = makeApp();
    const response = await request(app)
      .post('/api/app/runs/code-reviews')
      .send({ scopeId: SCOPE_ID, allowedPaths: ['../outside'] });
    expect(response.status).toBe(400);
    expect(mocks.startPlannerRun).not.toHaveBeenCalled();
  });
});
