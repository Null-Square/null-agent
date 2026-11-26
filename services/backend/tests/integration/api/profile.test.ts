import { vi, describe, it, expect, afterEach, beforeEach, type Mock } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ERROR_CODES } from '@null-ai/contracts';
import { apiErrorHandler } from '@/shared/errors';

type Mocks = {
  profileService: {
    getProfile: Mock;
    upsertProfile: Mock;
  };
  subscriptionService: {
    resolveOrganizationSubscription: Mock;
  };
  authMiddleware: Mock;
};

// Mock functions at module level
const mockProfileService = vi.hoisted(() => ({
  getProfile: vi.fn(),
  upsertProfile: vi.fn(),
}));

const mockSubscriptionService = {
  resolveOrganizationSubscription: vi.fn(),
};
const mockResolvePrimaryOrganizationMembership = vi.fn();

let mockUser: any = { id: 'u1', email: 'u@test.com' };
const mockAuthMiddleware = vi.fn((req, _res, next) => {
  if (mockUser !== null) {
    (req as any).user = mockUser;
  }
  next();
});

// Setup mocks at module level for Vitest
vi.mock('@/domains/platform/profiles/profileService', () => ({
  profileService: mockProfileService,
  default: mockProfileService,
}));

vi.mock('@/app/services/platform/subscriptions/subscriptionAppService', () => ({
  subscriptionAppService: mockSubscriptionService,
}));


vi.mock('@/shared/middleware/auth.middleware', () => ({
  __esModule: true,
  authMiddleware: mockAuthMiddleware,
}));

vi.mock('@/shared/auth/resolveOrgMembership', () => ({
  resolvePrimaryOrganizationMembership: (...args: any[]) => mockResolvePrimaryOrganizationMembership(...args),
}));

const profileRecord = (fullName: string) => ({
  id: 'u1',
  user_id: 'u1',
  full_name: fullName,
  preferences: null,
  created_at: new Date('2026-11-26T00:00:00.000Z'),
  updated_at: new Date('2026-11-26T00:00:00.000Z'),
});

const buildApp = async (opts: { user?: any } = {}): Promise<{ app: express.Express; mocks: Mocks }> => {
  // Set the mock user for this test
  mockUser = opts.user === null ? null : (opts.user ?? { id: 'u1', email: 'u@test.com' });

  // Import after mocks are set up
  const { default: profileRouter } = await import('@/interfaces/http/controllers/profile');

  const app = express();
  app.locals.isDev = true;
  app.use(express.json());
  app.use('/profile', profileRouter);
  app.use(apiErrorHandler);

  return {
    app,
    mocks: {
      profileService: mockProfileService,
      subscriptionService: mockSubscriptionService,
      authMiddleware: mockAuthMiddleware
    }
  };
};

describe('profile controller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'u1', email: 'u@test.com' };
    mockResolvePrimaryOrganizationMembership.mockResolvedValue({ organizationId: 'org-profile', role: 'admin' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns profile for authenticated user', async () => {
    const { app, mocks } = await buildApp();
    mocks.profileService.getProfile.mockResolvedValue(profileRecord('Test'));

    const res = await request(app).get('/profile').expect(200);

    expect(mocks.profileService.getProfile).toHaveBeenCalledWith('u1');
    expect(res.body.profile).toEqual({
      id: 'u1',
      user_id: 'u1',
      full_name: 'Test',
      created_at: '2026-11-26T00:00:00.000Z',
      updated_at: '2026-11-26T00:00:00.000Z',
    });
  });

  it('returns 401 when auth middleware does not attach user', async () => {
    const { app } = await buildApp({ user: null });
    await request(app).get('/profile').expect(401);
  });

  it('validates update payload and returns 400 on invalid types', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .put('/profile')
      .send({ name: 123 }) // invalid type
      .expect(400);

    expect(res.body.code).toBe(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED);
  });

  it('updates profile successfully', async () => {
    const { app, mocks } = await buildApp();
    mocks.profileService.upsertProfile.mockResolvedValue(profileRecord('Ok'));

    const res = await request(app).put('/profile').send({ name: 'Ok' }).expect(200);

    expect(mocks.profileService.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ full_name: 'Ok', user_id: 'u1' }),
    );
    expect(res.body.profile).toMatchObject({ user_id: 'u1', full_name: 'Ok' });
  });

  it('returns subscription snapshot', async () => {
    const { app, mocks } = await buildApp();
    mocks.subscriptionService.resolveOrganizationSubscription.mockResolvedValue({
      plan: { slug: 'control' },
      creditsCurrent: 5,
      periodStart: 's',
      periodEnd: 'e',
    });

    const res = await request(app).get('/profile/subscription').expect(200);

    expect(res.body.subscription.plan.slug).toBe('control');
    expect(mocks.subscriptionService.resolveOrganizationSubscription).toHaveBeenCalledWith('org-profile', {
      billingContactUserId: 'u1',
    });
  });
});
