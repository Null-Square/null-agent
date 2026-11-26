import { subscriptionAppService } from '@/app/services/platform/subscriptions/subscriptionAppService';
import { notificationAppService } from '@/app/services/platform/notifications/notificationAppService';
import { modelAppService } from '@/app/services/platform/models/modelAppService';
import { AccessControlService } from '@/app/services/platform/subscriptions/accessControlAppService';
import { profileAppService } from '@/app/services/platform/profiles/profileAppService';

const buildPlatformKernel = () => ({
  subscriptions: subscriptionAppService,
  notifications: notificationAppService,
  models: modelAppService,
  profiles: profileAppService,
  accessControl: new AccessControlService(),
});

export type PlatformKernel = ReturnType<typeof buildPlatformKernel>;

export const createPlatformKernel = (overrides: Partial<PlatformKernel> = {}): PlatformKernel => ({
  ...buildPlatformKernel(),
  ...overrides,
});
