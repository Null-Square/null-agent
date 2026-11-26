import { describe, expect, it, vi } from 'vitest';

import {
  RiskReadModelService,
  exposureRiskState,
  findingRiskState,
  mergeRiskSources,
  summarizeRiskCountRows,
  type ExposureRiskSourceRow,
  type FindingRiskSourceRow,
  type RiskCountSourceRow,
  type RiskSourceReader,
} from '@/domains/security-ops/risks/RiskReadModelService';

const finding = (overrides: Partial<FindingRiskSourceRow> = {}): FindingRiskSourceRow => ({
  id: 'finding-1',
  title: 'Cross-tenant export',
  severity: 'critical',
  state: 'potential',
  sourceKind: 'assessment',
  repositoryId: null,
  assetValue: 'jobs.example.com',
  scopeName: 'Production',
  cvssScore: 9.1,
  lastSeenAt: '2026-04-06T09:00:00.000Z',
  ...overrides,
});

const exposure = (overrides: Partial<ExposureRiskSourceRow> = {}): ExposureRiskSourceRow => ({
  id: 'exposure-1',
  riskId: null,
  state: 'candidate',
  advisoryId: 'CVE-2026-1111',
  severity: 'high',
  cvssScore: 8.1,
  kevListed: false,
  componentName: 'openssl',
  componentVersion: '3.0.1',
  backportRisk: false,
  versionConflict: false,
  assetValue: 'api.example.com',
  inventoryObservedAt: '2026-04-06T10:00:00.000Z',
  firstSeenAt: '2026-04-05T10:00:00.000Z',
  ...overrides,
});

describe('risk state ladder', () => {
  it('uses the canonical Risk state without another mapping layer', () => {
    expect(findingRiskState(finding({ state: 'resolved' }))).toBe('resolved');
    expect(findingRiskState(finding({ state: 'accepted' }))).toBe('accepted');
  });

  it('maps finding and exposure states without overclaiming', () => {
    expect(findingRiskState(finding({ state: 'confirmed' }))).toBe('confirmed');
    expect(findingRiskState(finding({ state: 'verifying' }))).toBe('verifying');
    expect(findingRiskState(finding({ state: 'potential' }))).toBe('potential');
    expect(findingRiskState(finding({ state: 'dismissed' }))).toBe('dismissed');
    expect(findingRiskState(finding({ state: 'not_reproduced' }))).toBe('not_reproduced');
    expect(exposureRiskState('confirmed')).toBe('confirmed');
    expect(exposureRiskState('verifying')).toBe('verifying');
    expect(exposureRiskState('dismissed')).toBe('dismissed');
    expect(exposureRiskState('stale')).toBe('dismissed');
    expect(exposureRiskState('not_reproduced')).toBe('not_reproduced');
    expect(exposureRiskState('inconclusive')).toBe('not_reproduced');
  });
});

describe('mergeRiskSources', () => {
  it('removes an exposure only when its linked finding is in the selected feed', () => {
    const rows = mergeRiskSources(
      [finding({ id: 'finding-from-exposure' })],
      [exposure({ riskId: 'finding-from-exposure', state: 'confirmed' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'finding-from-exposure', recordKind: 'finding' });
  });

  it('keeps a linked exposure when its finding is outside the selected scope', () => {
    const rows = mergeRiskSources(
      [],
      [exposure({ riskId: 'finding-in-another-scope', state: 'confirmed' })],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'exposure-1', recordKind: 'exposure', state: 'confirmed' });
  });

  it('keeps a confirmed exposure when finding creation did not produce a link', () => {
    const rows = mergeRiskSources([], [exposure({ riskId: null, state: 'confirmed' })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'exposure-1', recordKind: 'exposure', state: 'confirmed' });
  });

  it('keys equal table ids by record kind so rows cannot collide', () => {
    const rows = mergeRiskSources(
      [finding({ id: 'shared-id' })],
      [exposure({ id: 'shared-id', riskId: null })],
    );

    expect(rows.map((row) => row.key).sort()).toEqual([
      'exposure:shared-id',
      'finding:shared-id',
    ]);
  });

  it('returns the final common shape in newest-first order', () => {
    const rows = mergeRiskSources(
      [finding({ id: 'older', lastSeenAt: '2026-04-01T00:00:00.000Z' })],
      [exposure({ id: 'newer', inventoryObservedAt: '2026-04-09T00:00:00.000Z', kevListed: true })],
    );

    expect(rows.map((row) => row.id)).toEqual(['newer', 'older']);
    expect(rows[0]).toMatchObject({
      key: 'exposure:newer',
      title: 'CVE-2026-1111 in openssl 3.0.1',
      kevListed: true,
    });
    expect(rows[0]).not.toHaveProperty('sortAt');
  });
});

describe('summarizeRiskCountRows', () => {
  it('combines already de-duplicated source groups into one exact summary', () => {
    const summary = summarizeRiskCountRows(
      [
        { state: 'confirmed', severity: 'critical', count: 2, kevCount: 0 },
        { state: 'resolved', severity: 'high', count: 1, kevCount: 0 },
      ],
      [
        { state: 'potential', severity: 'high', count: 3, kevCount: 2 },
        { state: 'dismissed', severity: 'medium', count: 1, kevCount: 1 },
      ],
    );

    expect(summary).toMatchObject({
      total: 7,
      open: 5,
      openKev: 2,
      byState: { confirmed: 2, potential: 3, resolved: 1, dismissed: 1 },
      openBySeverity: { critical: 2, high: 3 },
    });
  });
});

describe('RiskReadModelService', () => {
  it('does not read the gated exposure source when the plan cannot use it', async () => {
    const sources: RiskSourceReader = {
      listFindings: vi.fn(async () => [finding()]),
      listExposures: vi.fn(async () => [exposure()]),
      summarizeFindings: vi.fn(async () => []),
      summarizeExposures: vi.fn(async () => []),
    };
    const service = new RiskReadModelService(sources);

    const rows = await service.list({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      includeExposures: false,
    });

    expect(rows).toHaveLength(1);
    expect(sources.listFindings).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'scope-1' }));
    expect(sources.listExposures).not.toHaveBeenCalled();
  });

  it('reads both sources with the same scope when exposure access is allowed', async () => {
    const sources: RiskSourceReader = {
      listFindings: vi.fn(async () => [finding()]),
      listExposures: vi.fn(async () => [exposure()]),
      summarizeFindings: vi.fn(async () => []),
      summarizeExposures: vi.fn(async () => []),
    };
    const service = new RiskReadModelService(sources);

    const rows = await service.list({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      includeExposures: true,
    });

    expect(rows).toHaveLength(2);
    expect(sources.listFindings).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'scope-1' }));
    expect(sources.listExposures).toHaveBeenCalledWith(expect.objectContaining({ scopeId: 'scope-1' }));
  });

  it('uses the same access gate for list rows and summary counts', async () => {
    const sources: RiskSourceReader = {
      listFindings: vi.fn(async () => [finding()]),
      listExposures: vi.fn(async () => [exposure()]),
      summarizeFindings: vi.fn(async (): Promise<RiskCountSourceRow[]> => [
        { state: 'potential', severity: 'critical', count: 1, kevCount: 0 },
      ]),
      summarizeExposures: vi.fn(async (): Promise<RiskCountSourceRow[]> => [
        { state: 'potential', severity: 'high', count: 1, kevCount: 1 },
      ]),
    };
    const service = new RiskReadModelService(sources);

    const result = await service.read({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      includeExposures: false,
    });

    expect(result.risks).toHaveLength(1);
    expect(result.summary).toMatchObject({ total: 1, open: 1, openKev: 0 });
    expect(sources.listExposures).not.toHaveBeenCalled();
    expect(sources.summarizeExposures).not.toHaveBeenCalled();
  });
});
