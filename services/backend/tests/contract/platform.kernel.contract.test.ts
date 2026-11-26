import { describe, expect, it } from 'vitest';
import { createAuthRouter } from '@/interfaces/http/controllers/auth';
import profileRouter from '@/interfaces/http/controllers/profile';
import notificationsRouter from '@/interfaces/http/controllers/notifications.router';
import { createPlatformKernel } from '@/app/platform/kernel';

describe('platform kernel contract', () => {
  it('constructs the kept platform routers with minimal deps', () => {
    expect(() => createAuthRouter()).not.toThrow();
    expect(profileRouter).toBeDefined();
    expect(notificationsRouter).toBeDefined();
  });

  it('holds only what the local product uses: the plan, notifications, models, the profile and access control', () => {
    expect(Object.keys(createPlatformKernel()).sort()).toEqual([
      'accessControl',
      'models',
      'notifications',
      'profiles',
      'subscriptions',
    ]);
  });
});
