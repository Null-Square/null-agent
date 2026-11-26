import type { NextFunction, Response } from 'express';

import {
  roleHasAllCapabilities,
  type OrgCapability,
} from '@/shared/auth/capabilities';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AuthenticatedRequest } from '@/shared/types/express';

export const requireCapability =
  (...capabilities: OrgCapability[]) =>
  async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next(new AppError(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS, 'Not authenticated'));
      }

      if (!req.organizationId || !req.orgRole || !req.orgContextSource) {
        return next(
          new AppError(
            ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            'Organization context is required before capability checks',
          ),
        );
      }

      if (!req.orgRole || !roleHasAllCapabilities(req.orgRole, capabilities)) {
        return next(
          new AppError(
            ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
            `Insufficient permissions. Required org capabilities: ${capabilities.join(' | ')}`,
          ),
        );
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
