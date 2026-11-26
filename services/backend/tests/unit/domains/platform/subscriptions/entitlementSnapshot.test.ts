import { describe, expect, it } from 'vitest';
import { buildPlanEntitlementSnapshot } from '@/domains/platform/subscriptions/entitlementSnapshot';
import type { SubscriptionRecord } from '@/domains/platform/subscriptions/subscriptionService';

const subscription = (experienceProfile: 'inactive' | 'results' | 'workbench'): SubscriptionRecord => ({
  userId: 'user-1',
  organizationId: 'org-1',
  plan: {
    id: 'plan-1',
    slug: experienceProfile === 'results' ? 'watch' : experienceProfile,
    name: experienceProfile,
    experienceProfile,
    features: {
      accessThreatWatch: false,
    },
    limits: {
      allowedModelCategories: experienceProfile === 'results' ? ['low'] : [],
    },
  },
});

describe('buildPlanEntitlementSnapshot', () => {
  it('keeps a results profile on results-only entitlements and reports no credits', () => {
    const snapshot = buildPlanEntitlementSnapshot(subscription('results'));

    expect(snapshot.experienceProfile).toBe('results');
    expect(snapshot.features.threatWatch.available).toBe(false);
    expect(snapshot.features.automations.available).toBe(false);
    expect(snapshot.limits.allowedModelCategories).toEqual(['low']);
    expect(snapshot).not.toHaveProperty('credits');
  });

  it('fails a missing profile closed', () => {
    const record = subscription('workbench');
    record.plan.experienceProfile = undefined;

    expect(buildPlanEntitlementSnapshot(record).experienceProfile).toBe('inactive');
  });
});
