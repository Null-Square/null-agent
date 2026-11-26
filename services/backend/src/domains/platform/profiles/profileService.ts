import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users, type UserRow, type NewUserRow } from '@/db/schema';

export type ProfileRecord = {
  id: string;
  user_id: string;
  full_name: string | null;
  preferences: UserRow['preferences'];
  created_at: Date;
  updated_at: Date;
};

export interface ProfileUpsertInput extends Partial<Omit<ProfileRecord, 'created_at' | 'updated_at' | 'id'>> {
  user_id: string;
}

class ProfileService {
  private mapUserToProfile(user: UserRow): ProfileRecord {
    return {
      id: user.id,
      user_id: user.id,
      full_name: user.full_name ?? null,
      preferences: user.preferences,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  }

  async getProfile(userId: string): Promise<ProfileRecord | null> {
    const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return result[0] ? this.mapUserToProfile(result[0]) : null;
  }

  async upsertProfile(input: ProfileUpsertInput): Promise<ProfileRecord> {
    const existingUser = await this.getProfile(input.user_id);
    if (!existingUser) {
      throw new Error('User not found');
    }

    const existingPreferences = existingUser.preferences ?? {};
    const incomingPreferences = input.preferences ? { ...input.preferences } : undefined;
    const existingProgress = existingPreferences.onboardingProgress;
    const incomingProgress = incomingPreferences?.onboardingProgress;
    if (incomingPreferences && existingPreferences.onboardingCompletedAt) {
      incomingPreferences.onboardingCompletedAt = existingPreferences.onboardingCompletedAt;
    }
    if (
      incomingPreferences &&
      existingProgress &&
      incomingProgress &&
      !incomingPreferences.onboardingCompletedAt &&
      existingProgress.lastCompletedStep > incomingProgress.lastCompletedStep
    ) {
      incomingPreferences.onboardingProgress = existingProgress;
    }

    const mergedPreferences =
      incomingPreferences !== undefined
        ? {
            ...existingPreferences,
            ...incomingPreferences,
          }
        : undefined;

    const updates: Partial<NewUserRow> = {
      updated_at: new Date(),
      ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
      ...(mergedPreferences !== undefined ? { preferences: mergedPreferences } : {}),
    };

    const [updatedUser] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, input.user_id))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    return this.mapUserToProfile(updatedUser);
  }
}

export const profileService = new ProfileService();
export default profileService;
