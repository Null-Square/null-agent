import { beforeEach, describe, expect, it, vi } from 'vitest';
import type profileServiceExport from '@/domains/platform/profiles/profileService';

const mocks = vi.hoisted(() => ({
  selectRows: [] as any[],
  updateReturn: [] as any[],
  lastUpdateValues: null as any,
  lastUpdateWhere: null as any,
}));

vi.mock('@/db/client', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mocks.selectRows)),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values) => {
        mocks.lastUpdateValues = values;
        return {
          where: vi.fn((where) => {
            mocks.lastUpdateWhere = where;
            return {
              returning: vi.fn(() => Promise.resolve(mocks.updateReturn)),
              then: (resolve: (value: void) => void) => resolve(),
            };
          }),
        };
      }),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  users: {
    id: 'users.id',
  },
}));

const eqMock = vi.fn((field, value) => ({ field, value }));
vi.mock('drizzle-orm', () => ({
  eq: eqMock,
}));

let profileService: typeof profileServiceExport;

describe('profileService', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.updateReturn = [];
    mocks.lastUpdateValues = null;
    mocks.lastUpdateWhere = null;

    vi.resetModules();
    profileService = (await import('@/domains/platform/profiles/profileService')).default;
  });

  it('returns mapped profile when user exists', async () => {
    const userRow = {
      id: 'u1',
      full_name: 'User',
      preferences: {},
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };
    mocks.selectRows = [userRow];

    const result = await profileService.getProfile('u1');

    expect(result).toEqual({
      ...userRow,
      user_id: 'u1',
    });
    expect(eqMock).toHaveBeenCalledWith('users.id', 'u1');
  });

  it('returns null when user is missing', async () => {
    mocks.selectRows = [];

    const result = await profileService.getProfile('u1');

    expect(result).toBeNull();
  });

  it('updates user profile with defaults', async () => {
    mocks.selectRows = [
      {
        id: 'u1',
        full_name: 'User',
        preferences: { theme: 'dark' },
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
      },
    ];
    const updatedRow = {
      id: 'u1',
      full_name: 'User',
      preferences: { theme: 'dark' },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-03T00:00:00.000Z'),
    };
    mocks.updateReturn = [updatedRow];

    const result = await profileService.upsertProfile({
      user_id: 'u1',
      full_name: 'User',
    });

    expect(result).toEqual({
      ...updatedRow,
      user_id: 'u1',
    });
    expect(mocks.lastUpdateValues).toMatchObject({
      full_name: 'User',
      updated_at: expect.any(Date),
    });
    expect(eqMock).toHaveBeenCalledWith('users.id', 'u1');
  });

  it('merges preferences and preserves full_name on partial updates', async () => {
    const existingRow = {
      id: 'u1',
      full_name: 'Existing User',
      preferences: { theme: 'dark', language: 'en' },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };
    mocks.selectRows = [existingRow];
    mocks.updateReturn = [
      {
        ...existingRow,
        preferences: {
          ...existingRow.preferences,
          onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z',
        },
        updated_at: new Date('2026-03-28T00:00:00.000Z'),
      },
    ];

    await profileService.upsertProfile({
      user_id: 'u1',
      preferences: { onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z' },
    });

    expect(mocks.lastUpdateValues).toMatchObject({
      preferences: {
        theme: 'dark',
        language: 'en',
        onboardingWelcomeSeenAt: '2026-03-28T00:00:00.000Z',
      },
    });
    expect(mocks.lastUpdateValues).not.toHaveProperty('full_name');
  });

  it('does not let an older onboarding tab regress a newer checkpoint', async () => {
    const newerProgress = {
      version: 1 as const,
      lastCompletedStep: 4,
      formData: { orgName: 'NullSquare' },
      scopeId: 'scope-1',
      targetId: 'target-1',
      targetSnapshot: 'domain:example.com:dns_txt',
      updatedAt: '2026-07-26T00:04:00.000Z',
    };
    const existingRow = {
      id: 'u1',
      full_name: 'Existing User',
      preferences: { onboardingProgress: newerProgress },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-07-26T00:04:00.000Z'),
    };
    mocks.selectRows = [existingRow];
    mocks.updateReturn = [existingRow];

    await profileService.upsertProfile({
      user_id: 'u1',
      preferences: {
        onboardingProgress: {
          ...newerProgress,
          lastCompletedStep: 2,
          scopeId: null,
          targetId: null,
          targetSnapshot: '',
          updatedAt: '2026-07-26T00:02:00.000Z',
        },
      },
    });

    expect(mocks.lastUpdateValues.preferences.onboardingProgress).toEqual(newerProgress);
  });

  it('accepts the redesigned two-step progress when onboarding is completed', async () => {
    const legacyProgress = {
      version: 1 as const,
      lastCompletedStep: 5,
      formData: { orgName: 'NullSquare', scopeName: 'Legacy' },
      scopeId: 'scope-old',
      targetId: 'target-old',
      targetSnapshot: 'domain:old.example:dns_txt',
      updatedAt: '2026-07-26T00:05:00.000Z',
    };
    const completedProgress = {
      ...legacyProgress,
      lastCompletedStep: 2,
      formData: { orgName: 'NullSquare', scopeName: 'example.com Website', targetValue: 'example.com' },
      scopeId: 'scope-1',
      targetId: 'target-1',
      targetSnapshot: 'domain:example.com:dns_txt',
      updatedAt: '2026-08-11T10:00:00.000Z',
    };
    const existingRow = {
      id: 'u1',
      full_name: 'Existing User',
      preferences: { onboardingProgress: legacyProgress },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-07-26T00:05:00.000Z'),
    };
    mocks.selectRows = [existingRow];
    mocks.updateReturn = [existingRow];

    await profileService.upsertProfile({
      user_id: 'u1',
      preferences: {
        onboardingCompletedAt: '2026-08-11T10:00:00.000Z',
        onboardingProgress: completedProgress,
      },
    });

    expect(mocks.lastUpdateValues.preferences.onboardingProgress).toEqual(completedProgress);
  });

  it('does not let a completed account clear its onboarding completion marker', async () => {
    const completedAt = '2026-08-11T10:00:00.000Z';
    const existingRow = {
      id: 'u1',
      full_name: 'Existing User',
      preferences: { onboardingCompletedAt: completedAt },
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date(completedAt),
    };
    mocks.selectRows = [existingRow];
    mocks.updateReturn = [existingRow];

    await profileService.upsertProfile({
      user_id: 'u1',
      preferences: { onboardingCompletedAt: '' },
    });

    expect(mocks.lastUpdateValues.preferences.onboardingCompletedAt).toBe(completedAt);
  });

  it('throws when upsert target user is missing', async () => {
    mocks.updateReturn = [];

    await expect(
      profileService.upsertProfile({
        user_id: 'u-missing',
      }),
    ).rejects.toThrow('User not found');
  });

});
