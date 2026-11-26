import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AppError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const orgServiceMocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
}));

const runnerServiceMocks = vi.hoisted(() => ({
  listRunners: vi.fn(),
  deployRunner: vi.fn(),
}));

const accessControlMocks = vi.hoisted(() => ({
  enforcePrivateRunnerAccess: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {},
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

vi.mock('@/interfaces/http/middleware/orgContext', () => ({
  requirePrimaryOrgContext: (req: { organizationId?: string; orgRole?: string; orgContextSource?: string }, _res: unknown, next: () => void) => {
    req.organizationId = 'org-1';
    req.orgRole = 'admin';
    req.orgContextSource = 'primary';
    next();
  },
  requireRunnerOrgContext:
    () =>
    (req: { organizationId?: string; orgRole?: string; orgContextSource?: string }, _res: unknown, next: () => void) => {
      req.organizationId = 'org-1';
      req.orgRole = 'admin';
      req.orgContextSource = 'resource';
      next();
    },
}));

vi.mock('@/interfaces/http/middleware/requireCapability', () => ({
  requireCapability:
    () =>
    (_req: unknown, _res: unknown, next: () => void) => {
      next();
    },
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: class MockOrganizationService {
    getForUser = orgServiceMocks.getForUser;
  },
}));

vi.mock('@/domains/security-ops/runners/RunnerService', () => ({
  RunnerService: class MockRunnerService {
    listRunners = runnerServiceMocks.listRunners;
    deployRunner = runnerServiceMocks.deployRunner;
    getRunner = vi.fn();
    deleteRunner = vi.fn();
    updateScopeAssignments = vi.fn();
    rotateToken = vi.fn();
  },
}));

vi.mock('@/domains/security-ops/audit/AuditService', () => ({
  AuditService: class MockAuditService {
    log = vi.fn();
  },
}));

vi.mock('@/app/platform/kernel', () => ({
  createPlatformKernel: () => ({
    accessControl: {
      enforcePrivateRunnerAccess: accessControlMocks.enforcePrivateRunnerAccess,
    },
  }),
}));

import { createRunnersRouter } from '@/interfaces/http/controllers/runners.router';

describe('runners.router contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgServiceMocks.getForUser.mockResolvedValue({ id: 'org-1' });
    runnerServiceMocks.listRunners.mockResolvedValue([]);
    runnerServiceMocks.deployRunner.mockResolvedValue({
      runner: {
        id: 'runner-1',
        name: 'Private Runner',
        type: 'private',
        status: 'online',
        platform: 'linux',
        architecture: 'amd64',
        ipAddress: null,
        version: null,
        lastHeartbeatAt: null,
        assignedScopes: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      token: 'runner-token',
      installCommand: 'docker run ...',
    });
    accessControlMocks.enforcePrivateRunnerAccess.mockResolvedValue(undefined);
  });

  it('preserves entitlement errors when runner fleet access is blocked', async () => {
    accessControlMocks.enforcePrivateRunnerAccess.mockRejectedValue(
      new AppError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 'Private runners are not available on your plan', {
        httpStatus: 403,
        context: {
          feature: 'accessPrivateRunners',
          currentPlan: 'inactive',
        },
      }),
    );

    const app = express();
    app.locals.isDev = true;
    app.use(express.json());
    app.use('/api/app/runners', createRunnersRouter());

    const response = await request(app).get('/api/app/runners');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE);
    expect(response.body.message).toBe('Private runners are not available on your plan');
    expect(response.body.context.feature).toBe('accessPrivateRunners');
    expect(runnerServiceMocks.listRunners).not.toHaveBeenCalled();
  });

  it('blocks runner deployment when runner fleet access is unavailable', async () => {
    accessControlMocks.enforcePrivateRunnerAccess.mockRejectedValue(
      new AppError(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE, 'Private runners are not available on your plan', {
        httpStatus: 403,
        context: {
          feature: 'accessPrivateRunners',
          currentPlan: 'inactive',
        },
      }),
    );

    const app = express();
    app.locals.isDev = true;
    app.use(express.json());
    app.use('/api/app/runners', createRunnersRouter());

    const response = await request(app).post('/api/app/runners').send({
      name: 'Blocked Runner',
      type: 'private',
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE);
    expect(response.body.message).toBe('Private runners are not available on your plan');
    expect(runnerServiceMocks.deployRunner).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Production proxy parity tests
  //
  // These tests reproduce the exact production failure mode:
  //   Caddy terminates TLS → forwards plain HTTP to Express →
  //   Express needs `trust proxy` to read X-Forwarded-Proto: https.
  //
  // Without `trust proxy`, req.protocol is always 'http' inside Docker,
  // resolveRunnerApiUrl() builds 'http://api.nullsquare.net', and the
  // production HTTPS guard fires → 400.
  // ---------------------------------------------------------------------------

  describe('production proxy parity', () => {
    const savedEnv = process.env.NODE_ENV;
    const savedRunnerApiUrl = process.env.RUNNER_API_URL;
    const savedApiUrl = process.env.API_URL;

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      delete process.env.RUNNER_API_URL;
      delete process.env.API_URL;
    });

    afterEach(() => {
      process.env.NODE_ENV = savedEnv;
      if (savedRunnerApiUrl !== undefined) process.env.RUNNER_API_URL = savedRunnerApiUrl;
      if (savedApiUrl !== undefined) process.env.API_URL = savedApiUrl;
    });

    it('returns 400 without trust proxy — reproduces the production bug', async () => {
      const app = express();
      // Deliberately no trust proxy — this is the broken state
      app.use(express.json());
      app.use('/api/app/runners', createRunnersRouter());

      const response = await request(app)
        .post('/api/app/runners')
        .set('X-Forwarded-Proto', 'https')
        .set('X-Forwarded-Host', 'api.nullsquare.net')
        .send({ name: 'Prod Runner', type: 'private' });

      // req.protocol is 'http' because trust proxy is off → detectedOrigin is
      // 'http://api.nullsquare.net' → HTTPS guard fires → 400
      expect(response.status).toBe(400);
      expect(runnerServiceMocks.deployRunner).not.toHaveBeenCalled();
    });

    it('deploys successfully with trust proxy enabled and Caddy X-Forwarded-Proto: https', async () => {
      const app = express();
      app.set('trust proxy', 1); // the fix
      app.use(express.json());
      app.use('/api/app/runners', createRunnersRouter());

      // Simulate what Caddy actually sends to the backend:
      //   - Host: api.nullsquare.net  (original client Host header, passed through by Caddy)
      //   - X-Forwarded-Proto: https  (Caddy adds this — TLS was terminated at Caddy)
      // With trust proxy, Express reads X-Forwarded-Proto → req.protocol = 'https'
      // req.get('host') returns the Host header → 'api.nullsquare.net'
      // So detectedOrigin = 'https://api.nullsquare.net' — the correct URL
      const response = await request(app)
        .post('/api/app/runners')
        .set('Host', 'api.nullsquare.net')
        .set('X-Forwarded-Proto', 'https')
        .send({ name: 'Prod Runner', type: 'private' });

      expect(response.status).toBe(201);
      expect(runnerServiceMocks.deployRunner).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ apiUrl: 'https://api.nullsquare.net' }),
      );
    });

    it('deploys successfully when RUNNER_API_URL is set explicitly (env-var override path)', async () => {
      process.env.RUNNER_API_URL = 'https://api.nullsquare.net';

      const app = express();
      // Even without trust proxy, explicit env var bypasses detection
      app.use(express.json());
      app.use('/api/app/runners', createRunnersRouter());

      const response = await request(app)
        .post('/api/app/runners')
        .send({ name: 'Prod Runner', type: 'private' });

      expect(response.status).toBe(201);
      expect(runnerServiceMocks.deployRunner).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ apiUrl: 'https://api.nullsquare.net' }),
      );
    });
  });
});
