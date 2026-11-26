import express, { type Response, type Router } from 'express';
import { createPlatformKernel, type PlatformKernel } from '@/app/platform/kernel';
import type { ProfileRecord } from '@/app/services/platform/profiles/profileAppService';
import { authMiddleware, type AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import { z } from 'zod';
import { validate } from './ai-agent/middleware';
import { toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { sendApiError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';
import { resolvePrimaryOrganizationMembership } from '@/shared/auth/resolveOrgMembership';

const onboardingProgressSchema = z.object({
  version: z.literal(1),
  lastCompletedStep: z.number().int().min(0).max(5),
  formData: z.record(z.string(), z.unknown()),
  scopeId: z.string().nullable(),
  targetId: z.string().nullable(),
  targetSnapshot: z.string(),
  updatedAt: z.string(),
});

const toProfileJson = (record: ProfileRecord | null) =>
  record
    ? {
        id: record.id,
        user_id: record.user_id,
        full_name: record.full_name ?? undefined,
        preferences: record.preferences ?? undefined,
        created_at: record.created_at?.toISOString(),
        updated_at: record.updated_at?.toISOString(),
      }
    : null;

export const createProfileRouter = (kernel: PlatformKernel = createPlatformKernel()): Router => {
  const profileRouter: Router = express.Router();

  const updateProfileSchema = z.object({
    full_name: z.string().optional(),
    name: z.string().optional(),
    preferences: z
      .object({
        theme: z.enum(['light', 'dark', 'system']).optional(),
        pushNotifications: z.boolean().optional(),
        emailNotifications: z.boolean().optional(),
        cookieConsent: z.boolean().optional(),
        language: z.string().optional(),
        onboardingWelcomeSeenAt: z.string().optional(),
        onboardingCompletedAt: z.string().optional(),
        onboardingProgress: onboardingProgressSchema.optional(),
        communicationPreferences: z.record(z.object({
          email: z.boolean().optional(),
          push: z.boolean().optional(),
          inApp: z.boolean().optional(),
        })).optional(),
      })
      .optional(),
  });

  profileRouter.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }

      const profile = toProfileJson(await kernel.profiles.getProfile(user.id));
      res.status(200).json({ profile });
    } catch (error: unknown) {
      const appErr = toAppError(error);
      logger.error({ err: appErr }, 'Get profile error');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Internal server error while fetching profile',
      });
    }
  });

  profileRouter.get('/full', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }

      const profile = toProfileJson(await kernel.profiles.getProfile(user.id));
      res.status(200).json({ data: { profile } });
    } catch (error: unknown) {
      const appErr = toAppError(error);
      logger.error({ err: appErr }, 'Get full profile error');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Internal server error while fetching full profile',
      });
    }
  });

  profileRouter.put(
    '/',
    authMiddleware,
    validate({ body: updateProfileSchema }),
    async (req: AuthenticatedRequest, res: Response) => {
      try {
        const user = req.user;
        if (!user) {
          return sendApiError(res, {
            code: ERROR_CODES.AUTH_INVALID_SESSION,
            message: 'Authentication required',
            status: 401,
          });
        }

        const body = req.body as Record<string, unknown>;
        const fullName =
          typeof body['full_name'] === 'string'
            ? body['full_name']
            : typeof body['name'] === 'string'
              ? body['name']
              : undefined;

        const profileData = {
          user_id: user.id,
          full_name: fullName,
          preferences:
            body['preferences'] && typeof body['preferences'] === 'object'
              ? body['preferences']
              : undefined,
        };

        const profile = toProfileJson(await kernel.profiles.upsertProfile(profileData));
        res.status(200).json({ message: 'Profile updated successfully', profile });
      } catch (error: unknown) {
        const appErr = toAppError(error);
        logger.error({ err: appErr }, 'Update profile error');
        sendApiError(res, {
          code: ERROR_CODES.INTERNAL_UNEXPECTED,
          message: 'Internal server error while updating profile',
        });
      }
    },
  );

  profileRouter.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }

      const body = req.body as Record<string, unknown>;
      const fullName =
        typeof body['full_name'] === 'string'
          ? body['full_name']
          : typeof body['name'] === 'string'
            ? body['name']
            : undefined;

      const profileData = {
        user_id: user.id,
        full_name: fullName,
        preferences:
          body['preferences'] && typeof body['preferences'] === 'object'
            ? body['preferences']
            : undefined,
      };

      const profile = toProfileJson(await kernel.profiles.upsertProfile(profileData));
      res.status(200).json({ message: 'Profile created/updated successfully', profile });
    } catch (error: unknown) {
      const appErr = toAppError(error);
      logger.error({ err: appErr }, 'Create/update profile error');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Internal server error while creating/updating profile',
      });
    }
  });

  profileRouter.get('/subscription', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return sendApiError(res, {
          code: ERROR_CODES.AUTH_INVALID_SESSION,
          message: 'Authentication required',
          status: 401,
        });
      }
      const { organizationId } = await resolvePrimaryOrganizationMembership(user.id);
      const sub = await kernel.subscriptions.resolveOrganizationSubscription(organizationId, {
        billingContactUserId: user.id,
      });
      res.status(200).json({
        subscription: {
          plan: {
            id: sub.plan.id,
            slug: sub.plan.slug,
            name: sub.plan.name,
            experienceProfile: sub.plan.experienceProfile ?? 'workbench',
            features: sub.plan.features,
            limits: sub.plan.limits,
          },
        },
      });
    } catch (error: unknown) {
      const appErr = toAppError(error);
      logger.error({ err: appErr }, 'Get subscription error');
      sendApiError(res, {
        code: ERROR_CODES.INTERNAL_UNEXPECTED,
        message: 'Internal server error while fetching subscription',
      });
    }
  });

  return profileRouter;
};

export default createProfileRouter();

