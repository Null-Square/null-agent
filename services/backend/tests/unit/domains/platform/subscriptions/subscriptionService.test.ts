import { describe, it, expect } from 'vitest';
import { MODEL_CATEGORIES } from '@null-ai/contracts';
import subscriptionService, { LOCAL_PLAN } from '@/domains/platform/subscriptions/subscriptionService';

const ORG_1 = '00000000-0000-4000-8000-000000000101';
const USER_1 = '00000000-0000-4000-8000-000000000001';

describe('subscriptionService', () => {
  it('defines one plan: the local workbench plan with every feature and no limits', () => {
    expect(LOCAL_PLAN.slug).toBe('local');
    expect(LOCAL_PLAN.name).toBe('Local');
    expect(LOCAL_PLAN.experienceProfile).toBe('workbench');
    expect(Object.values(LOCAL_PLAN.features ?? {}).every((enabled) => enabled === true)).toBe(true);
    expect(LOCAL_PLAN.limits).toEqual({
      maxConcurrentRuns: null,
      maxActiveScopes: null,
      maxAutomations: null,
      maxOrganizationUsers: null,
      allowedModelCategories: [...MODEL_CATEGORIES],
    });
  });

  it('resolves every organization to the local plan without a database', async () => {
    const record = await subscriptionService.resolveOrganizationSubscription(ORG_1, {
      billingContactUserId: USER_1,
    });

    expect(record).toEqual({ userId: USER_1, organizationId: ORG_1, plan: LOCAL_PLAN });
    expect(record).not.toHaveProperty('creditsCurrent');
  });

  it('hands out copies, so a caller cannot change the plan for everyone', async () => {
    const record = await subscriptionService.resolveOrganizationSubscription(ORG_1);
    record.plan.features!.accessAutomations = false;
    record.plan.limits!.allowedModelCategories!.length = 0;

    const next = await subscriptionService.resolveOrganizationSubscription(ORG_1);
    expect(next.plan.features?.accessAutomations).toBe(true);
    expect(next.plan.limits?.allowedModelCategories).toEqual([...MODEL_CATEGORIES]);
  });

  it('resolves an anonymous caller to the local plan as well', () => {
    expect(subscriptionService.resolveAnonymousSubscription('someone').plan).toEqual(LOCAL_PLAN);
  });
});
