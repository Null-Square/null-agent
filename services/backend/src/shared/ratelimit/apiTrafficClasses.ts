import type { RequestHandler } from 'express';

import { RATE_LIMIT_WINDOW_MS } from '@/config/timeouts';
import { rateLimit } from './rateLimit';

export const API_RATE_LIMIT_POLICIES = {
  authenticatedIngress: { windowMs: RATE_LIMIT_WINDOW_MS, max: 3_000 },
  interactiveUser: { windowMs: RATE_LIMIT_WINDOW_MS, max: 300 },
  auth: { windowMs: RATE_LIMIT_WINDOW_MS, max: 120 },
} as const;

const clientIpKey = (req: Parameters<RequestHandler>[0]): string =>
  `ip:${req.ip || req.socket.remoteAddress || 'anonymous'}`;

const authenticatedUserKey = (req: Parameters<RequestHandler>[0]): string => {
  const userId = req.user?.id ?? req.userId ?? req.auth?.userId;
  return userId ? `user:${userId}` : clientIpKey(req);
};

/**
 * One limiter per traffic class. Names are intentionally shared across mounts
 * in the same class, while identity is user-based for interactive traffic and
 * IP-based for unauthenticated ingress protection.
 */
export const createApiTrafficClassLimiters = () => ({
  authenticatedIngress: rateLimit({
    name: 'api-authenticated-ingress',
    ...API_RATE_LIMIT_POLICIES.authenticatedIngress,
    keyGenerator: clientIpKey,
  }),
  interactiveUser: rateLimit({
    name: 'api-interactive-user',
    ...API_RATE_LIMIT_POLICIES.interactiveUser,
    keyGenerator: authenticatedUserKey,
  }),
  auth: rateLimit({
    name: 'api-auth',
    ...API_RATE_LIMIT_POLICIES.auth,
    keyGenerator: clientIpKey,
  }),
});
