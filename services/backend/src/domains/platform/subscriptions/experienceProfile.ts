import { z } from 'zod';

export const EXPERIENCE_PROFILES = ['inactive', 'results', 'workbench'] as const;

export const ExperienceProfileSchema = z.enum(EXPERIENCE_PROFILES);

export type ExperienceProfile = z.infer<typeof ExperienceProfileSchema>;

export const parseExperienceProfile = (value: unknown): ExperienceProfile => {
  const parsed = ExperienceProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : 'inactive';
};
