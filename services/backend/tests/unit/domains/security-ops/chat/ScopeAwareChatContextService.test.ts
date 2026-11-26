import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import type { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import { loadAssetFocusEnrichments } from '@/domains/security-ops/assets/assetFocus';
import {
  ScopeAwareChatContextService,
  SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
  SCOPE_AWARE_CHAT_CONTEXT_SECTIONS,
  SCOPE_AWARE_CHAT_CONTEXT_START_MARKER,
  SCOPE_AWARE_CHAT_CONTEXT_END_MARKER,
} from '@/domains/security-ops/chat/ScopeAwareChatContextService';
import { ERROR_CODES } from '@/shared/errors';

vi.mock('@/domains/security-ops/assets/assetFocus', () => ({
  loadAssetFocusEnrichments: vi.fn().mockResolvedValue(new Map()),
  compareAssetPriorityCandidates: (left: { needsBroadScan?: boolean; focus: { score: number }; value: string }, right: { needsBroadScan?: boolean; focus: { score: number }; value: string }) => {
    const leftNeedsBroadScan = left.needsBroadScan === true ? 0 : 1;
    const rightNeedsBroadScan = right.needsBroadScan === true ? 0 : 1;
    if (leftNeedsBroadScan !== rightNeedsBroadScan) {
      return leftNeedsBroadScan - rightNeedsBroadScan;
    }
    if (left.focus.score !== right.focus.score) {
      return right.focus.score - left.focus.score;
    }
    return left.value.localeCompare(right.value);
  },
  toPriorityAssetSummary: (asset: { id: string; value: string; focus: { label: string; reasons: string[] } }) => ({
    assetId: asset.id,
    value: asset.value,
    label: asset.focus.label,
    reasons: asset.focus.reasons,
  }),
}));

const parseRenderedEnvelope = (renderedContext: string) => {
  const start = renderedContext.indexOf(SCOPE_AWARE_CHAT_CONTEXT_START_MARKER);
  const end = renderedContext.indexOf(SCOPE_AWARE_CHAT_CONTEXT_END_MARKER);
  const jsonPayload = renderedContext
    .slice(start + SCOPE_AWARE_CHAT_CONTEXT_START_MARKER.length, end)
    .trim();
  return JSON.parse(jsonPayload);
};

describe('ScopeAwareChatContextService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-17T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a stable scope-aware envelope and rendered context block', async () => {
    vi.mocked(loadAssetFocusEnrichments).mockResolvedValueOnce(new Map([
      ['asset-1', { needsBroadScan: true, focus: { score: 88, label: 'critical', reasons: ['Customer-facing surface', 'Regulated or compliance-sensitive data'] } }],
    ]) as any);
    const db = {
      select: vi.fn(() => {
        const chain: any = {
          from: () => chain,
          where: () => Promise.resolve([
            { id: 'asset-1', kind: 'domain', value: 'example.com', lastScannedAt: null },
          ]),
        };
        return chain;
      }),
    };
    const orgService = {
      getForUser: vi.fn().mockResolvedValue({ id: 'org-1' }),
      getOrgContext: vi.fn().mockResolvedValue({
        name: 'Acme Security',
        context: 'payments processing',
      }),
    } as unknown as OrganizationService;
    const scopeService = {
      getById: vi.fn().mockResolvedValue({
        scope: {
          id: 'scope-1',
          name: 'Production',
          status: 'active',
          safeMode: true,
        },
      }),
      getScopeContext: vi.fn().mockResolvedValue({
        name: 'Production',
        targets: [{ type: 'domain', value: 'example.com', verified: true }],
        mission: null,
        stealthPosture: 'coordinated',
        impactTolerance: 'non_destructive',
        rateLimitRps: null,
        blastWindow: null,
        roeDocument: 'No destructive actions. Pause for approval before risky tests.',
        testingPosture: 'black-box',
        testingPostureReason: 'no source access or credentials attached',
        whiteboxEnabled: false,
        connectedRepoCount: 0,
        connectedRepositories: [],
        accessMaterialCount: 0,
        accessMaterials: [],
      }),
    } as unknown as ScopeService;

    const service = new ScopeAwareChatContextService(db as never, orgService, scopeService);
    const result = await service.buildForUser({
      userId: 'user-1',
      scopeId: 'scope-1',
      userExtraContext: 'Focus on auth endpoints first.',
    });

    expect(result.metadata).toEqual({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      schema: SCOPE_AWARE_CHAT_CONTEXT_SCHEMA,
      sections: [...SCOPE_AWARE_CHAT_CONTEXT_SECTIONS],
    });
    expect(result.envelope.schema).toBe(SCOPE_AWARE_CHAT_CONTEXT_SCHEMA);
    expect(result.envelope.generatedAt).toBe('2026-02-17T12:00:00.000Z');
    expect(result.envelope.priorityAssets).toEqual([
      {
        assetId: 'asset-1',
        value: 'example.com',
        label: 'critical',
        reasons: ['Customer-facing surface', 'Regulated or compliance-sensitive data'],
      },
    ]);
    const { generatedAt: _generatedAt, ...cacheStableEnvelope } = result.envelope;
    expect(parseRenderedEnvelope(result.renderedContext)).toEqual(cacheStableEnvelope);
    expect(result.renderedContext).not.toContain('generatedAt');
    expect(result.renderedContext).toContain('=== OPERATOR NOTES ===');
    expect(result.renderedContext).toContain('Focus on auth endpoints first.');
  });

  it('throws resource.not_found when scope cannot be resolved for the user org', async () => {
    const db = {
      select: vi.fn(),
    };
    const orgService = {
      getForUser: vi.fn().mockResolvedValue({ id: 'org-1' }),
      getOrgContext: vi.fn(),
    } as unknown as OrganizationService;
    const scopeService = {
      getById: vi.fn().mockRejectedValue(new Error('scope missing')),
      getScopeContext: vi.fn(),
    } as unknown as ScopeService;

    const service = new ScopeAwareChatContextService(db as never, orgService, scopeService);

    await expect(
      service.buildForUser({
        userId: 'user-1',
        scopeId: 'scope-missing',
      }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Scope not found',
    });
  });
});
