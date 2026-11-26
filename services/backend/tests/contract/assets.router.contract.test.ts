import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetsRouter } from '@/interfaces/http/controllers/assets.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SCOPE_ID = '22222222-2222-4222-8222-222222222222';

const authState = vi.hoisted(() => ({
  role: 'lead',
  userId: 'user-1',
}));

const dbMocks = vi.hoisted(() => {
  const selectResults: unknown[] = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];

  const next = () => {
    if (selectResults.length === 0) {
      throw new Error('No queued DB select result');
    }
    return selectResults.shift();
  };

  const db: any = {
    select: vi.fn(() => {
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(next()),
        then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
          Promise.resolve(next()).then(onfulfilled, onrejected),
      };
      return chain;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        insertCalls.push({ table, values });
        return Promise.resolve();
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn((where: unknown) => {
          updateCalls.push({ table, values, where });
          return Promise.resolve();
        }),
      })),
    })),
  };

  return {
    db,
    selectResults,
    insertCalls,
    updateCalls,
  };
});

vi.mock('@/db/client', () => ({
  db: dbMocks.db,
}));

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.user = { id: authState.userId, email: 'lead@test.com', role: 'user' };
    req.organizationId = ORG_ID;
    req.orgRole = authState.role;
    req.orgContextSource = 'primary';
    next();
  },
}));

vi.mock('@/interfaces/http/middleware/orgContext', () => ({
  requireAssetOrgContext:
    () =>
    (req: { organizationId?: string; orgRole?: string; orgContextSource?: string }, _res: unknown, next: () => void) => {
      req.organizationId = ORG_ID;
      req.orgRole = authState.role;
      req.orgContextSource = 'resource';
      next();
    },
}));

vi.mock('@/domains/security-ops/organization/OrganizationService', () => ({
  OrganizationService: class {
    async getForUser() {
      return { id: ORG_ID };
    }
  },
}));

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/app/assets', createAssetsRouter());
  app.use(errorHandler);
  return app;
};

describe('assets router contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.role = 'lead';
    dbMocks.selectResults.length = 0;
    dbMocks.insertCalls.length = 0;
    dbMocks.updateCalls.length = 0;
  });

  it('lists assets with evidence-derived focus', async () => {
    dbMocks.selectResults.push(
      [
        {
          id: 'asset-1',
          kind: 'domain',
          value: 'api.example.com',
          tags: ['prod'],
          scopeId: SCOPE_ID,
          lastScannedAt: null,
          firstSeenAt: new Date('2026-04-01T00:00:00.000Z'),
          lastSeenAt: new Date('2026-04-02T00:00:00.000Z'),
          findingCount: 2,
          serviceCount: 1,
          endpointCount: 3,
          observationCount: 5,
          subdomainCount: 1,
        },
      ],
      [
        {
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.27.0',
          lastSeenAt: new Date('2026-04-02T01:00:00.000Z'),
        },
      ],
      [],
      [],
      [{ assetId: 'asset-1', severity: 'high' }],
      [{ type: 'domain', value: 'api.example.com' }],
    );

    const res = await request(buildApp()).get(`/api/app/assets?scopeId=${SCOPE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: 'asset-1',
        focus: expect.objectContaining({
          label: 'critical',
        }),
      }),
    ]);
  });

  it('returns confirmed assets without lifecycle state or a promotion signal', async () => {
    dbMocks.selectResults.push(
      [
        {
          id: 'asset-2',
          kind: 'domain',
          value: 'portal.example.com',
          tags: ['auth'],
          scopeId: SCOPE_ID,
          lastScannedAt: null,
          firstSeenAt: new Date('2026-04-03T00:00:00.000Z'),
          lastSeenAt: new Date('2026-04-04T00:00:00.000Z'),
          findingCount: 0,
          serviceCount: 1,
          endpointCount: 2,
          observationCount: 4,
          subdomainCount: 0,
        },
      ],
      [],
      [
        {
          assetId: 'asset-2',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.27.0',
          lastSeenAt: new Date('2026-04-04T01:00:00.000Z'),
        },
      ],
      [],
      [],
      [],
      [{ type: 'domain', value: 'portal.example.com' }],
    );

    const res = await request(buildApp()).get(`/api/app/assets?scopeId=${SCOPE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: 'asset-2',
      }),
    ]);
    expect(res.body[0]).not.toHaveProperty('surfaceState');
    expect(res.body[0]).not.toHaveProperty('promotionSuggested');
  });

  it('returns asset detail with evidence-derived focus', async () => {
    dbMocks.selectResults.push(
      [
        {
          id: 'asset-1',
          organizationId: ORG_ID,
          scopeId: SCOPE_ID,
          userId: 'user-1',
          kind: 'domain',
          value: 'portal.example.com',
          tags: ['customer'],
          evidence: [],
          parentAssetId: null,
          lastScannedAt: null,
          firstSeenAt: new Date('2026-04-01T00:00:00.000Z'),
          lastSeenAt: new Date('2026-04-02T00:00:00.000Z'),
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
          updatedAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
      [{ count: 0 }],
      [{ count: 1 }],
      [{ count: 2 }],
      [{ count: 4 }],
      [{ count: 0 }],
      [
        {
          assetId: 'asset-1',
          protocol: 'https',
          port: 443,
          serviceName: 'https',
          product: 'nginx',
          version: '1.27.0',
          lastSeenAt: new Date('2026-04-02T01:00:00.000Z'),
        },
      ],
      [],
      [],
      [],
      [{ type: 'domain', value: 'portal.example.com' }],
    );

    const res = await request(buildApp()).get('/api/app/assets/asset-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 'asset-1',
        focus: expect.objectContaining({
          reasons: expect.arrayContaining(['Mapped services exist but the asset is still untested']),
        }),
      }),
    );
  });

  it('returns only the curated latest scan coverage summary', async () => {
    dbMocks.selectResults.push(
      [{ id: 'asset-1' }],
      [
        {
          data: {
            family: 'auth-surface',
            status: 'completed',
            profileVersion: 'v2026.04',
            inventoryFingerprint: 'internal-fingerprint',
            reason: 'internal planner context',
            toolset: ['request_tool', 'browser'],
            stats: {
              endpointsDiscovered: '7',
              findingsCreated: 1,
              techsDetected: 2,
            },
          },
          lastSeenAt: new Date('2026-04-06T09:24:10.000Z'),
          sessionId: 'internal-session',
          confidence: 0.93,
          evidence: [{ kind: 'internal' }],
        },
      ],
    );

    const res = await request(buildApp()).get('/api/app/assets/asset-1/scan-coverage');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'completed',
      assessedAt: '2026-04-06T09:24:10.000Z',
      endpointsDiscovered: 7,
      findingsCreated: 1,
      technologiesDetected: 2,
    });
  });

  it('returns null when the asset has no scan coverage', async () => {
    dbMocks.selectResults.push([{ id: 'asset-1' }], []);

    const res = await request(buildApp()).get('/api/app/assets/asset-1/scan-coverage');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('does not expose the generic asset notes endpoint', async () => {
    const res = await request(buildApp()).get('/api/app/assets/asset-1/notes?ntype=scan.coverage');

    expect(res.status).toBe(404);
    expect(dbMocks.db.select).not.toHaveBeenCalled();
  });

  it('does not expose the removed asset profile endpoint', async () => {
    const res = await request(buildApp())
      .patch('/api/app/assets/asset-1/profile')
      .send({ businessCriticality: 'high' });

    expect(res.status).toBe(404);
    expect(dbMocks.insertCalls).toHaveLength(0);
    expect(dbMocks.updateCalls).toHaveLength(0);
  });

  it.each(['promote', 'demote', 'ignore'])('does not expose the removed %s endpoint', async (action) => {
    const res = await request(buildApp())
      .post(`/api/app/assets/asset-1/${action}`)
      .send({ to: 'managed', reason: 'No user-authored lifecycle state.' });

    expect(res.status).toBe(404);
    expect(dbMocks.insertCalls).toHaveLength(0);
    expect(dbMocks.updateCalls).toHaveLength(0);
  });
});
