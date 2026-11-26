import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@shared/api';
import { parseApiError } from '@shared/lib/apiError';
import type { ModelCategory } from '@null-ai/contracts';

export type SubscriptionPlanFeatures = {
  accessAutomations?: boolean;
  accessPrivateRunners?: boolean;
  accessCompliance?: boolean;
  accessCodeReview?: boolean;
  accessRunObservability?: boolean;
};

export type SubscriptionPlan = {
  id: string;
  name: string;
  slug: string;
  features?: SubscriptionPlanFeatures;
  limits?: {
    maxConcurrentRuns?: number | null;
    maxActiveScopes?: number | null;
    maxAutomations?: number | null;
    maxOrganizationUsers?: number | null;
    allowedModelCategories?: ModelCategory[] | null;
  };
};

/** The plan this computer runs on: the local workbench plan, every feature and no limits. */
export type SubscriptionRecord = {
  plan: SubscriptionPlan;
};

/**
 * Null AI has no sign-in: the local owner is always there (the backend's `localOwner`), so the
 * plan is asked for as soon as the person is known.
 */
export const useSubscriptionQuery = (enabled = true) =>
  useQuery<SubscriptionRecord | null>({
    queryKey: ['subscription'],
    enabled,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/profile/subscription');
      if (error) throw parseApiError(error);
      const subscription = data?.subscription;
      if (!subscription?.plan) return null;
      return {
        plan: {
          id: subscription.plan.slug,
          name: subscription.plan.name,
          slug: subscription.plan.slug,
          features: subscription.plan.features ?? undefined,
          limits: subscription.plan.limits ?? undefined,
        },
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

export const useRefreshSubscription = () => {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['subscription'] });
};
