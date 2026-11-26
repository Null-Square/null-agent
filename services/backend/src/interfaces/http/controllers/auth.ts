import express, { type Request, type Response, type Router } from 'express';
import { authMiddleware, OWNER_KEY_REQUIRED_MESSAGE, type AuthenticatedRequest } from '@/shared/middleware/auth.middleware';
import { isOwnerKey, ownerCookieHeader } from '@/shared/auth/ownerKey';
import { sendApiError } from '@/shared/errors';
import { ERROR_CODES } from '@null-ai/contracts';

/**
 * Who is using Null AI. There is no sign-in: the person is the local owner (`localOwner`), proven by
 * the owner key. `POST /claim` trades the key from the printed link for the browser's cookie, and
 * `GET /me` says who that is.
 */
export const createAuthRouter = (): Router => {
  const authRouter: Router = express.Router();

  authRouter.post('/claim', (req: Request, res: Response) => {
    const key: unknown = req.app?.locals?.ownerKey;
    const provided: unknown = (req.body as { key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || !isOwnerKey(provided, key)) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INVALID_SESSION,
        message: OWNER_KEY_REQUIRED_MESSAGE,
        status: 401,
      });
    }
    res.setHeader('Set-Cookie', ownerCookieHeader(key));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  });

  authRouter.get('/me', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
    const user = req.user;
    if (!user) {
      return sendApiError(res, {
        code: ERROR_CODES.AUTH_INVALID_SESSION,
        message: OWNER_KEY_REQUIRED_MESSAGE,
        status: 401,
      });
    }
    res.status(200).json({
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        updated_at: user.updated_at,
        role: user.role,
      },
    });
  });

  return authRouter;
};
