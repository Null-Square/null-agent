import { type Response, type NextFunction } from 'express';
import { ERROR_CODES } from '@null-ai/contracts';
import { localOwner } from '@/shared/auth/localOwner';
import { carriesOwnerKey } from '@/shared/auth/ownerKey';
import { AppError } from '@/shared/errors';
import type { AuthenticatedRequest, AuthenticatedUser } from '@/shared/types/express';

export type { AuthenticatedRequest, AuthenticatedUser };

export const OWNER_KEY_REQUIRED_MESSAGE = 'Open Null AI from the link it printed when it started.';

/**
 * Who is asking. Null AI has one person, the local owner (`localOwner`), and no sign-in. A request
 * is that person only when it carries the owner key (`ownerKey.ts`): the cookie the link sets, or the
 * key as a bearer token. Anything else, a container or another program on this computer included,
 * is refused. `localHostOnly` still decides who may reach the app at all.
 */
export const authMiddleware = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    // Route trees authenticate once at their boundary; nested routers may keep this middleware.
    if (req.user) {
      next();
      return;
    }

    const key: unknown = req.app?.locals?.ownerKey;
    if (typeof key !== 'string' || !carriesOwnerKey(req.headers, key)) {
      next(new AppError(ERROR_CODES.AUTH_INVALID_SESSION, OWNER_KEY_REQUIRED_MESSAGE, {
        userMessage: OWNER_KEY_REQUIRED_MESSAGE,
      }));
      return;
    }

    req.user = await localOwner();
    next();
  } catch (error: unknown) {
    next(error);
  }
};
