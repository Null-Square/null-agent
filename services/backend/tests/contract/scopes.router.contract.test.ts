import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AppError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

const dbMocks = vi.hoisted(() => {
  const selectLimitRows = { current: [] as any[] };

  const selectChain: any = {
    from: vi.fn(() => selectChain),
    innerJoin: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
    limit: vi.fn(() => Promise.resolve(selectLimitRows.current)),
  };

  const db = {
    select: vi.fn(() => selectChain),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };

  return {
    selectLimitRows,
    selectChain,
    db,
  };
});

const orgServiceMocks = vi.hoisted(() => ({
  getForUser: vi.fn(),
}));

const scopeServiceMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  countActive: vi.fn(),
  create: vi.fn(),
  addTarget: vi.fn(),
  autoVerifyTarget: vi.fn(),
}));

const accessMaterialServiceMocks = vi.hoisted(() => ({
  listForScope: vi.fn(),
  createForScope: vi.fn(),
  updateForScope: vi.fn(),
  deleteForScope: vi.fn(),
}));

const accessControlMocks = vi.hoisted(() => ({
  enforceScopeCreation: vi.fn(),
}));

const scopeAuthorizationMocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  assertStatementCoversChange: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: dbMocks.db,
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

vi.mock('@/interfaces/http/middleware/orgContext', () => ({
  requireScopeOrgContext:
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

vi.mock('@/domains/security-ops/scopes/ScopeService', () => ({
  ScopeService: class MockScopeService {
    list = scopeServiceMocks.list;
    getById = scopeServiceMocks.getById;
    countActive = scopeServiceMocks.countActive;
    create = scopeServiceMocks.create;
    addTarget = scopeServiceMocks.addTarget;
    autoVerifyTarget = scopeServiceMocks.autoVerifyTarget;
  },
}));

vi.mock('@/domains/security-ops/scopes/ScopeAccessMaterialService', () => ({
  ScopeAccessMaterialService: class MockScopeAccessMaterialService {
    listForScope = accessMaterialServiceMocks.listForScope;
    createForScope = accessMaterialServiceMocks.createForScope;
    updateForScope = accessMaterialServiceMocks.updateForScope;
    deleteForScope = accessMaterialServiceMocks.deleteForScope;
  },
}));

vi.mock('@/domains/security-ops/scopes/ScopeAuthorizationRecorder', () => ({
  ScopeAuthorizationRecorder: class MockScopeAuthorizationRecorder {
    readContract = scopeAuthorizationMocks.readContract;
    assertStatementCoversChange = scopeAuthorizationMocks.assertStatementCoversChange;
    record = scopeAuthorizationMocks.record;
  },
}));

vi.mock('@/app/platform/kernel', () => ({
  createPlatformKernel: () => ({
    accessControl: {
      enforceScopeCreation: accessControlMocks.enforceScopeCreation,
    },
  }),
}));

vi.mock('@/domains/security-ops/audit/AuditService', () => ({
  AuditService: class MockAuditService {
    log = vi.fn();
  },
}));

import { createScopesRouter } from '@/interfaces/http/controllers/scopes.router';

describe('scopes.router contract', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    orgServiceMocks.getForUser.mockResolvedValue({ id: 'org-1' });
    scopeServiceMocks.list.mockResolvedValue([
      {
        id: 'scope-1',
        name: 'Production',
        executionNetwork: 'external',
        safeMode: true,
        roeDocument: null,
        status: 'active',
        whiteboxEnabled: false,
        connectedRepoCount: 0,
        accessMaterialCount: 0,
        targetCount: 1,
        verifiedTargetCount: 1,
      },
    ]);
    scopeServiceMocks.getById.mockResolvedValue({
      scope: { id: 'scope-1', name: 'Production', accessMaterialCount: 2 },
      targets: [],
    });
    scopeAuthorizationMocks.readContract.mockResolvedValue({
      roots: [{ type: 'domain', value: 'api.example.com' }],
      exclusions: [],
      impactTolerance: 'safe',
      executionNetwork: 'external',
    });
    scopeAuthorizationMocks.assertStatementCoversChange.mockResolvedValue(undefined);
    scopeAuthorizationMocks.record.mockResolvedValue(undefined);
    scopeServiceMocks.countActive.mockResolvedValue(0);
    scopeServiceMocks.create.mockResolvedValue({
      id: 'scope-new',
      name: 'New Scope',
      executionNetwork: 'external',
      safeMode: true,
      roeDocument: null,
      status: 'active',
    });
    scopeServiceMocks.addTarget.mockResolvedValue({
      id: 'target-1',
      scopeId: 'scope-1',
      type: 'domain',
      value: 'example.com',
      verified: false,
      verificationMethod: 'dns_txt',
      verificationToken: 'verify-token',
      verifiedAt: null,
    });
    scopeServiceMocks.autoVerifyTarget.mockResolvedValue({
      verified: true,
      message: 'Auto verification complete',
    });
    accessMaterialServiceMocks.listForScope.mockResolvedValue([]);
    accessMaterialServiceMocks.createForScope.mockResolvedValue({
      id: 'material-1',
      scopeId: 'scope-1',
      kind: 'bearer_token',
      label: 'Staging API',
      username: null,
      headerName: null,
      notes: 'Scoped token',
      appliesToHosts: ['api.example.com'],
      lastUsedAt: null,
      createdAt: new Date('2026-04-03T10:00:00.000Z'),
      updatedAt: new Date('2026-04-03T10:00:00.000Z'),
    });
    accessMaterialServiceMocks.updateForScope.mockResolvedValue({
      id: 'material-1',
      scopeId: 'scope-1',
      kind: 'bearer_token',
      label: 'Updated Token',
      username: null,
      headerName: null,
      notes: 'Rotated',
      appliesToHosts: ['api.example.com'],
      lastUsedAt: null,
      createdAt: new Date('2026-04-03T10:00:00.000Z'),
      updatedAt: new Date('2026-04-03T11:00:00.000Z'),
    });
    accessMaterialServiceMocks.deleteForScope.mockResolvedValue(undefined);
    accessControlMocks.enforceScopeCreation.mockResolvedValue(undefined);
    dbMocks.selectLimitRows.current = [];
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns latest scope-level pentest plan note', async () => {
    dbMocks.selectLimitRows.current = [
      {
        id: 'note-1',
        scopeId: 'scope-1',
        assetId: null,
        ntype: 'pentest.plan',
        data: {
          recommended_next_task: 'web-app-scan',
          rationale: 'Endpoint coverage exists but parameter testing is incomplete',
          priority_targets: ['api.example.com'],
          confidence: 0.9,
        },
      },
    ];

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).get('/api/app/scopes/scope-1/plan');

    expect(response.status).toBe(200);
    expect(response.body.plan).toBeTruthy();
    expect(response.body.plan.ntype).toBe('pentest.plan');
    expect(response.body.plan.data.recommended_next_task).toBe('web-app-scan');
    expect(scopeServiceMocks.getById).toHaveBeenCalledWith('org-1', 'scope-1');
  });

  it('returns null plan payload when no pentest plan note exists', async () => {
    dbMocks.selectLimitRows.current = [];

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).get('/api/app/scopes/scope-1/plan');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ plan: null });
  });

  it('does not expose the generic scope-notes projection', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .get('/api/app/scopes/scope-1/notes?ntype=approach.tried');

    expect(response.status).toBe(404);
    expect(dbMocks.db.select).not.toHaveBeenCalled();
  });

  it('preserves subscription gate errors when scope creation is blocked', async () => {
    accessControlMocks.enforceScopeCreation.mockRejectedValue(
      new AppError(ERROR_CODES.RESOURCE_LIMIT_REACHED, 'Active scope limit reached for your plan', {
        httpStatus: 403,
        context: {
          feature: 'maxActiveScopes',
          limit: 1,
          activeScopes: 1,
        },
      }),
    );

    const app = express();
    app.locals.isDev = true;
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).post('/api/app/scopes').send({
      name: 'Blocked Scope',
      executionNetwork: 'external',
      safeMode: true,
    });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(ERROR_CODES.RESOURCE_LIMIT_REACHED);
    expect(response.body.message).toBe('Active scope limit reached for your plan');
    expect(response.body.context.feature).toBe('maxActiveScopes');
    expect(accessControlMocks.enforceScopeCreation).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      activeScopeCount: 0,
    });
  });

  it('allows auto verification in test mode by default', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .post('/api/app/scopes/scope-1/verify-auto')
      .send({ targetId: 'target-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      verified: true,
      message: 'Auto verification complete',
    });
    expect(scopeServiceMocks.autoVerifyTarget).toHaveBeenCalledWith('scope-1', 'target-1');
  });

  it('blocks auto verification outside dev/test', async () => {
    process.env.NODE_ENV = 'production';

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .post('/api/app/scopes/scope-1/verify-auto')
      .send({ targetId: 'target-1' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(scopeServiceMocks.autoVerifyTarget).not.toHaveBeenCalled();
  });

  it('lists scopes with target summary counts', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).get('/api/app/scopes');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({
        id: 'scope-1',
        targetCount: 1,
        verifiedTargetCount: 1,
      }),
    ]);
    expect(scopeServiceMocks.list).toHaveBeenCalledWith('org-1');
  });

  it('returns scope detail including access material count', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).get('/api/app/scopes/scope-1');

    expect(response.status).toBe(200);
    expect(response.body.scope.accessMaterialCount).toBe(2);
  });

  it('lists access materials for the scope', async () => {
    accessMaterialServiceMocks.listForScope.mockResolvedValue([
      {
        id: 'material-1',
        scopeId: 'scope-1',
        kind: 'custom_header',
        label: 'Admin Header',
        username: null,
        headerName: 'X-Admin-Key',
        notes: null,
        appliesToHosts: ['api.example.com'],
        lastUsedAt: null,
        createdAt: new Date('2026-04-03T10:00:00.000Z'),
        updatedAt: new Date('2026-04-03T10:00:00.000Z'),
      },
    ]);

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app).get('/api/app/scopes/scope-1/access-materials');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(accessMaterialServiceMocks.listForScope).toHaveBeenCalledWith('org-1', 'scope-1');
  });

  it('creates access material', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .post('/api/app/scopes/scope-1/access-materials')
      .send({
        kind: 'bearer_token',
        label: 'Staging API',
        token: 'secret-token',
        appliesToHosts: ['api.example.com'],
      });

    expect(response.status).toBe(201);
    expect(response.body.label).toBe('Staging API');
    expect(accessMaterialServiceMocks.createForScope).toHaveBeenCalledWith({
      orgId: 'org-1',
      scopeId: 'scope-1',
      actorUserId: 'user-1',
      input: {
        kind: 'bearer_token',
        label: 'Staging API',
        token: 'secret-token',
        appliesToHosts: ['api.example.com'],
      },
    });
  });

  it('allows adding another authorized target to a scope', async () => {
    scopeServiceMocks.addTarget.mockResolvedValueOnce({
      id: 'target-2',
      scopeId: 'scope-1',
      type: 'domain',
      value: 'api.example.com',
      verified: false,
      verificationMethod: 'dns_txt',
      verificationToken: 'verify-token-2',
      verifiedAt: null,
    });

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .post('/api/app/scopes/scope-1/targets')
      .send({
        type: 'domain',
        value: 'api.example.com',
        authorization: { accepted: true },
      });

    expect(response.status).toBe(201);
    expect(response.body.value).toBe('api.example.com');
  });

  it('passes verificationMethod through when adding a target', async () => {
    scopeServiceMocks.addTarget.mockResolvedValueOnce({
      id: 'target-2',
      scopeId: 'scope-1',
      type: 'domain',
      value: 'api.example.com',
      verified: false,
      verificationMethod: 'http_well_known',
      verificationToken: 'verify-token-2',
      verifiedAt: null,
    });

    const app = express();
    app.use(express.json());
    app.use('/api/app/scopes', createScopesRouter());

    const response = await request(app)
      .post('/api/app/scopes/scope-1/targets')
      .send({
        type: 'domain',
        value: 'api.example.com',
        verificationMethod: 'http_well_known',
        authorization: { accepted: true },
      });

    expect(response.status).toBe(201);
    expect(scopeServiceMocks.addTarget).toHaveBeenCalledWith('scope-1', {
      type: 'domain',
      value: 'api.example.com',
      verificationMethod: 'http_well_known',
    });
    expect(response.body.verificationMethod).toBe('http_well_known');
  });
});
