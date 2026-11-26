import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createExposureRouter } from '@/interfaces/http/controllers/exposure.router';

/**
 * The shape of one exposure, on the wire.
 *
 * The detail query selects a joined row — `{ match, advisory, component,
 * assetValue }` — and the response has to publish those four as siblings. It
 * published the whole row *under* `match` instead, so `component` and
 * `assetValue` never reached the client at all and `match` held four
 * sub-objects rather than the exposure. The page reads
 * `component.resolvedVersion` and died on `undefined`.
 *
 * Nothing asserted the response shape, which is why it shipped. This does.
 */

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const MATCH_ID = '3a740ce1-cfeb-4e17-858a-df1b515b3199';

const dbMocks = vi.hoisted(() => {
  const selectResults: unknown[] = [];

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
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(next()),
        then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
          Promise.resolve(next()).then(onfulfilled, onrejected),
      };
      return chain;
    }),
  };

  return { db, selectResults };
});

vi.mock('@/db/client', () => ({ db: dbMocks.db }));

vi.mock('@/interfaces/http/middleware/requireCapability', () => ({
  requireCapability: () => (_req: unknown, _res: unknown, next: () => void) => next(),
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
  app.use((req: any, _res, next) => {
    req.user = { id: 'user-1' };
    req.organizationId = ORG_ID;
    next();
  });
  app.use(
    '/api/app/exposure',
    createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn().mockResolvedValue(undefined),
        enforceRunCreation: vi.fn().mockResolvedValue(undefined),
      } as never,
    }),
  );
  return app;
};

/** The five selects the detail handler runs, in the order it runs them. */
const queueDetail = () => {
  dbMocks.selectResults.push(
    // 1. the joined row
    [
      {
        match: {
          id: MATCH_ID,
          organizationId: ORG_ID,
          assetId: 'asset-1',
          componentId: 'component-1',
          advisoryId: 'advisory-1',
          state: 'candidate',
          matchConfidence: 'exact_version',
          priorityScore: 71,
        },
        advisory: {
          id: 'advisory-1',
          canonicalId: 'CVE-2024-1234',
          severity: 'high',
        },
        component: {
          id: 'component-1',
          ecosystem: 'cpe',
          componentKey: 'cpe:f5:nginx',
          displayName: 'nginx',
          resolvedVersion: '1.18.0',
        },
        assetValue: 'shop.example.com',
      },
    ],
    // 2. events, 3. observations, 4. affected ranges, 5. overrides
    [],
    [],
    [],
    [],
  );
};

describe('exposure router contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults.length = 0;
  });

  it('publishes match, advisory, component and assetValue as siblings', async () => {
    queueDetail();

    const res = await request(buildApp()).get(`/api/app/exposure/${MATCH_ID}`);

    expect(res.status).toBe(200);
    // The bug: every one of these was undefined, and `match` was the wrapper.
    expect(res.body.component?.resolvedVersion).toBe('1.18.0');
    expect(res.body.advisory?.canonicalId).toBe('CVE-2024-1234');
    expect(res.body.assetValue).toBe('shop.example.com');
    expect(res.body.match?.id).toBe(MATCH_ID);
    expect(res.body.match?.state).toBe('candidate');
    // The exposure itself, not a container holding the other three.
    expect(res.body.match).not.toHaveProperty('component');
  });

  it('carries the collections the page reads', async () => {
    queueDetail();

    const res = await request(buildApp()).get(`/api/app/exposure/${MATCH_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.observations).toEqual([]);
    expect(res.body.affectedRanges).toEqual([]);
    expect(res.body.override).toBeNull();
  });

  it('answers 404 when the match belongs to nobody the caller can see', async () => {
    dbMocks.selectResults.push([]);

    const res = await request(buildApp()).get(`/api/app/exposure/${MATCH_ID}`);

    expect(res.status).toBe(404);
  });
});
