import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({ select: vi.fn() }));
const assetInScopeClauseMock = vi.hoisted(() => vi.fn(() => undefined));

vi.mock('@/db/client', () => ({ db: dbMock }));
vi.mock('@/domains/security-ops/assets/assetScopeFilter', () => ({
  assetInScopeClause: assetInScopeClauseMock,
}));

import { createExposureRouter } from '@/interfaces/http/controllers/exposure.router';

describe('exposure router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not restore the retired customer exposure-count route', () => {
    const router = createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn(),
        enforceRunCreation: vi.fn(),
      },
    });

    const paths = router.stack
      .map((layer) => layer.route?.path)
      .filter((path): path is string => typeof path === 'string');

    expect(paths).not.toContain('/summary/counts');
    expect(paths).toContain('/:id');
  });

  it('registers explicit create and remove routes for component corrections', () => {
    const router = createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn(),
        enforceRunCreation: vi.fn(),
      },
    });

    const overrideRoutes = router.stack
      .filter((layer) => layer.route?.path === '/:id/override')
      .map((layer) => (
        layer.route as unknown as { methods?: Record<string, boolean> }
      )?.methods ?? {});

    expect(overrideRoutes.some((methods) => methods.put)).toBe(true);
    expect(overrideRoutes.some((methods) => methods.delete)).toBe(true);
  });

  it('returns the canonical finding link in the exposure list', async () => {
    const row = {
      id: 'match-1',
      findingId: '1c3f09d7-7478-4ac1-81f6-492437739f6f',
      state: 'confirmed',
      matchConfidence: 'exact_version',
      priorityScore: 98,
      inventoryObservedAt: new Date('2026-08-01T10:00:00.000Z'),
      firstSeenAt: new Date('2026-07-30T10:00:00.000Z'),
      advisoryId: 'CVE-2021-44228',
      severity: 'critical',
      cvssScore: 10,
      kevListed: true,
      epssPercentile: 0.999,
      componentName: 'Apache Log4j',
      componentVersion: '2.14.1',
      backportRisk: false,
      versionConflict: false,
      assetValue: 'jobs.example.com',
    };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['from', 'innerJoin', 'where', 'orderBy']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => [row]);
    dbMock.select.mockReturnValue(chain);

    const router = createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn(),
        enforceRunCreation: vi.fn(),
      },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/');
    const handler = layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
    const json = vi.fn();
    const res = { json, status: vi.fn().mockReturnThis() };

    await handler({ organizationId: 'org-1', query: {} }, res, vi.fn());

    expect(json).toHaveBeenCalledWith({
      matches: [{
        ...row,
        inventoryObservedAt: '2026-08-01T10:00:00.000Z',
        firstSeenAt: '2026-07-30T10:00:00.000Z',
      }],
    });
  });

  it('rejects an invalid scope before querying exposure rows', async () => {
    const router = createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn(),
        enforceRunCreation: vi.fn(),
      },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/');
    const handler = layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
    const json = vi.fn();
    const status = vi.fn().mockReturnThis();

    await handler(
      { organizationId: 'org-1', query: { scopeId: 'not-a-uuid' } },
      { json, status },
      vi.fn(),
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'validation.invalid_format' }));
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('applies the shared asset scope predicate for a valid scope', async () => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['from', 'innerJoin', 'where', 'orderBy']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.limit = vi.fn(async () => []);
    dbMock.select.mockReturnValue(chain);
    const scopeId = '77215a67-bfdd-4df1-ab69-42a838c2ce91';
    const router = createExposureRouter({
      accessControl: {
        enforceThreatWatchAccess: vi.fn(),
        enforceRunCreation: vi.fn(),
      },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/');
    const handler = layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
    const json = vi.fn();

    await handler(
      { organizationId: 'org-1', query: { scopeId } },
      { json, status: vi.fn().mockReturnThis() },
      vi.fn(),
    );

    expect(assetInScopeClauseMock).toHaveBeenCalledWith(scopeId);
    expect(json).toHaveBeenCalledWith({ matches: [] });
  });
});
