import subscriptionService from '@/domains/platform/subscriptions/subscriptionService';

export type SubscriptionAppService = typeof subscriptionService;

export const subscriptionAppService: SubscriptionAppService = subscriptionService;

export type {
  SubscriptionPlan,
  SubscriptionRecord,
  TierFeatureFlags,
  TierLimits,
} from '@/domains/platform/subscriptions/subscriptionService';
