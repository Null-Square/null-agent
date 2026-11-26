import { vi, describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestServer } from '../unit/helpers/testAppHarness.helper';

// Use vi.hoisted() for mocks that need to be accessed in tests
const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  upsertProfile: vi.fn(),
  resolvePrimaryOrganizationMembership: vi.fn(),
}));

const profileRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'u-profile',
  user_id: 'u-profile',
  full_name: null,
  preferences: {},
  created_at: new Date('2026-11-01T00:00:00.000Z'),
  updated_at: new Date('2026-11-01T00:00:00.000Z'),
  ...overrides,
});

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (_req: any, res: any, next: any) => {
    if ((global as any).__PROFILE_AUTH_FAIL__) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    _req.user = { id: 'u-profile', email: 'user@test.com', role: 'user', created_at: 'ts' };
    next();
  },
}));

vi.mock('@/domains/platform/profiles/profileService', () => ({
  profileService: {
    getProfile: (...args: any[]) => mocks.getProfile(...args),
    upsertProfile: (...args: any[]) => mocks.upsertProfile(...args),
  },
}));

vi.mock('@/shared/auth/resolveOrgMembership', () => ({
  resolvePrimaryOrganizationMembership: (...args: any[]) =>
    mocks.resolvePrimaryOrganizationMembership(...args),
}));

describe('HTTP contracts - profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as any).__PROFILE_AUTH_FAIL__ = false;
    mocks.resolvePrimaryOrganizationMembership.mockResolvedValue({
      organizationId: 'org-profile',
      role: 'admin',
    });
  });

  it('GET /profile returns profile when available', async () => {
    mocks.getProfile.mockResolvedValue(profileRecord({ full_name: 'Test' }));
    const { server, close } = createTestServer();
    const res = await request(server).get('/api/profile');
    await close();

    expect(res.status).toBe(200);
    expect(res.body.profile.full_name).toBe('Test');
    expect(res.body.profile.created_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('PUT /profile updates profile and returns payload', async () => {
    mocks.upsertProfile.mockResolvedValue(
      profileRecord({
        full_name: 'Updated',
        preferences: { onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z' },
      }),
    );
    const { server, close } = createTestServer();
    const res = await request(server)
      .put('/api/profile')
      .send({
        name: 'Updated',
        preferences: { onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z' },
      });
    await close();

    expect(res.status).toBe(200);
    expect(res.body.profile.full_name).toBe('Updated');
    expect(res.body.profile.preferences.onboardingWelcomeSeenAt).toBe('2026-03-28T00:00:00.000Z');
    expect(mocks.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u-profile',
        full_name: 'Updated',
        preferences: { onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z' },
      }),
    );
  });

  it('GET /profile/subscription returns the local plan: every feature, no limits, no credits', async () => {
    const { server, close } = createTestServer();
    const res = await request(server).get('/api/profile/subscription');
    await close();

    expect(res.status).toBe(200);
    expect(res.body.subscription.plan).toMatchObject({
      slug: 'local',
      name: 'Local',
      experienceProfile: 'workbench',
      limits: {
        maxConcurrentRuns: null,
        maxActiveScopes: null,
        maxAutomations: null,
        maxOrganizationUsers: null,
      },
    });
    expect(Object.values(res.body.subscription.plan.features).every((enabled) => enabled === true)).toBe(true);
    expect(res.body.subscription).not.toHaveProperty('creditsCurrent');
    expect(res.body.subscription).not.toHaveProperty('billing');
  });

  it('PUT /profile accepts a validated onboarding checkpoint', async () => {
    const onboardingProgress = {
      version: 1,
      lastCompletedStep: 2,
      formData: { domain: 'example.com' },
      scopeId: null,
      targetId: null,
      targetSnapshot: 'example.com',
      updatedAt: '2026-03-28T00:00:00.000Z',
    };
    mocks.upsertProfile.mockResolvedValue(profileRecord({ preferences: { onboardingProgress } }));
    const { server, close } = createTestServer();
    const res = await request(server).put('/api/profile').send({ preferences: { onboardingProgress } });
    await close();

    expect(res.status).toBe(200);
    expect(res.body.profile.preferences.onboardingProgress).toEqual(onboardingProgress);
  });

  it('has no credit history: GET /profile/credits/history is not a route', async () => {
    const { server, close } = createTestServer();
    const res = await request(server).get('/api/profile/credits/history');
    await close();

    expect(res.status).toBe(404);
  });

  it('PUT /profile validation error returns 4xx', async () => {
    const { server, close } = createTestServer();
    const res = await request(server).put('/api/profile').send({ name: 123 });
    await close();

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns 401 when auth middleware rejects', async () => {
    (global as any).__PROFILE_AUTH_FAIL__ = true;
    const { server, close } = createTestServer();
    const res = await request(server).get('/api/profile');
    await close();

    expect(res.status).toBe(401);
  });
});
