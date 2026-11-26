import {
  profileService,
  type ProfileRecord,
  type ProfileUpsertInput,
} from '@/domains/platform/profiles/profileService';

export type { ProfileRecord, ProfileUpsertInput };

/** The person's profile (name and preferences), for the profile routes. */
export const profileAppService = {
  getProfile: (userId: string): Promise<ProfileRecord | null> => profileService.getProfile(userId),
  upsertProfile: (input: ProfileUpsertInput): Promise<ProfileRecord> => profileService.upsertProfile(input),
};
