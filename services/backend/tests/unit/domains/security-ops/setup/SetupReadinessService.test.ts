import { describe, expect, it } from 'vitest';

import {
  buildSetupReadiness,
  type SetupReadinessCounts,
} from '@/domains/security-ops/setup/SetupReadinessService';
import { buildPlanEntitlementSnapshot } from '@/domains/platform/subscriptions/entitlementSnapshot';
import type { ScopeDetail } from '@/domains/security-ops/scopes/ScopeService';

const baseCounts: SetupReadinessCounts = {
  targetCount: 0,
  verifiedTargetCount: 0,
  connectedRepoCount: 0,
  accessMaterialCount: 0,
  automationCount: 0,
  documentCount: 0,
};

const scopeDetail = (overrides?: {
  mission?: string | null;
  complianceFrameworks?: string[];
  targetCount?: number;
  verifiedTargetCount?: number;
  connectedRepoCount?: number;
  accessMaterialCount?: number;
}): ScopeDetail => ({
  scope: {
    id: 'scope-1',
    organizationId: 'org-1',
    name: 'Prod',
    executionNetwork: 'external',
    mission: overrides?.mission ?? null,
    impactTolerance: 'poc',
    complianceFrameworks: overrides?.complianceFrameworks ?? [],
    status: 'active',
    createdAt: new Date('2026-07-12T00:00:00.000Z'),
    updatedAt: new Date('2026-07-12T00:00:00.000Z'),
    whiteboxEnabled: Boolean(overrides?.connectedRepoCount),
    connectedRepoCount: overrides?.connectedRepoCount ?? 0,
    accessMaterialCount: overrides?.accessMaterialCount ?? 0,
    targetCount: overrides?.targetCount ?? 0,
    verifiedTargetCount: overrides?.verifiedTargetCount ?? 0,
    attachedRunner: null,
  },
  targets: [],
} as unknown as ScopeDetail);

describe('buildSetupReadiness', () => {
  it('marks a scope blocked when target and rules are missing', () => {
    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail(),
      counts: baseCounts,
      generatedAt: new Date('2026-07-12T12:00:00.000Z'),
    });

    expect(state.level).toBe('blocked');
    expect(state.progress.label).toBe('Action needed');
    expect(state.nextBestActions[0]?.id).toBe('add_target');
    expect(state.smartStarters.length).toBeGreaterThan(0);
    expect(state.smartStarters.map((item) => item.id)).toContain('create_automation');
  });

  it('treats a verified target as ready without a second authorization gate', () => {
    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({ targetCount: 1, verifiedTargetCount: 1 }),
      counts: {
        ...baseCounts,
        targetCount: 1,
        verifiedTargetCount: 1,
        documentCount: 0,
      },
    });

    expect(state.level).toBe('ready');
    expect(state.gates.map((gate) => gate.id)).not.toContain('authorization');
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('upload_document');
    expect(state.recommendations.map((item) => item.id)).not.toContain('upload_document');
  });

  it('marks a scope minimal when it has an unverified target', () => {
    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({ mission: 'Assess public app', targetCount: 1 }),
      counts: {
        ...baseCounts,
        targetCount: 1,
      },
    });

    expect(state.level).toBe('minimal');
    expect(state.nextBestActions[0]?.id).toBe('verify_target');
    expect(state.nextBestActions[0]?.dismissible).toBe(false);
  });

  it('filters a dismissed recommendation only for the matching setup signature', () => {
    const firstState = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({ mission: 'Assess public app', targetCount: 1 }),
      counts: {
        ...baseCounts,
        targetCount: 1,
      },
      generatedAt: new Date('2026-07-12T12:00:00.000Z'),
    });
    const verifyAction = firstState.recommendations.find((item) => item.id === 'verify_target');

    expect(verifyAction?.stateSignature).toBeTruthy();

    const dismissedState = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({ mission: 'Assess public app', targetCount: 1 }),
      counts: {
        ...baseCounts,
        targetCount: 1,
      },
      dismissals: [
        {
          actionId: 'verify_target',
          stateSignature: verifyAction?.stateSignature ?? '',
          dismissedAt: new Date('2026-07-12T12:01:00.000Z'),
        },
      ],
      generatedAt: new Date('2026-07-12T12:02:00.000Z'),
    });

    expect(dismissedState.recommendations.map((item) => item.id)).not.toContain('verify_target');
    expect(dismissedState.dismissedRecommendations.map((item) => item.id)).toContain('verify_target');
  });

  it('marks a fully enriched scope optimized', () => {
    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({
        mission: 'Assess public app',
        complianceFrameworks: ['soc2'],
        targetCount: 2,
        verifiedTargetCount: 2,
        connectedRepoCount: 1,
        accessMaterialCount: 1,
      }),
      counts: {
        ...baseCounts,
        targetCount: 2,
        verifiedTargetCount: 2,
        connectedRepoCount: 1,
        accessMaterialCount: 1,
        automationCount: 1,
      },
    });

    expect(state.level).toBe('optimized');
    expect(state.progress.percent).toBe(100);
    expect(state.nextBestActions).toHaveLength(0);
    expect(state.smartStarters.map((item) => item.id)).toContain('review_scope');
  });

  it('includes automation scheduling as a normal recommendation when the plan allows it', () => {
    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({
        mission: 'Assess public app',
        targetCount: 1,
        verifiedTargetCount: 1,
      }),
      counts: {
        ...baseCounts,
        targetCount: 1,
        verifiedTargetCount: 1,
      },
    });

    const automationAction = state.nextBestActions.find((item) => item.id === 'create_automation');

    expect(automationAction?.status).toBe('recommended');
    expect(automationAction?.dismissible).toBe(true);
    expect(automationAction?.priority).toBe(80);
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('add_access_material');
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('connect_repository');
  });

  it('does not suggest setup actions for unavailable plan features', () => {
    const entitlements = buildPlanEntitlementSnapshot({
      userId: 'user-1',
      organizationId: 'org-1',
      plan: {
        id: 'plan-free',
        name: 'Starter',
        slug: 'inactive',
        features: {
          accessAutomations: false,
          accessGitHubIntegrations: false,
          accessCompliance: false,
        },
        limits: {
          maxConcurrentRuns: 1,
          maxActiveScopes: 1,
          maxAutomations: null,
          maxOrganizationUsers: 1,
          allowedModelCategories: ['low'],
        },
      },
    });

    const state = buildSetupReadiness({
      organization: { id: 'org-1', name: 'Acme' },
      scopeDetail: scopeDetail({
        mission: 'Assess public app',
        targetCount: 1,
        verifiedTargetCount: 1,
      }),
      counts: {
        ...baseCounts,
        targetCount: 1,
        verifiedTargetCount: 1,
      },
      entitlements,
    });

    expect(state.entitlements?.features.automations.available).toBe(false);
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('create_automation');
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('connect_repository');
    expect(state.nextBestActions.map((item) => item.id)).not.toContain('add_access_material');
    expect(state.gates.find((gate) => gate.id === 'automation')?.description).toContain('not available');
  });
});
