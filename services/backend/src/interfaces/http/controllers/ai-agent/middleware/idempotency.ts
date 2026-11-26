import type { RequestHandler } from 'express';

type CachedResponse = {
  status: number;
  body: unknown;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedResponse>();

const prune = () => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
};

export const idempotency = (ttlMs: number = DEFAULT_TTL_MS): RequestHandler => {
  return (req, res, next) => {
    const key = req.header('x-idempotency-key');
    if (!key) return next();

    prune();

    const cached = cache.get(key);
    if (cached) {
      res.status(cached.status);
      return res.json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      cache.set(key, { status: res.statusCode, body, expiresAt: Date.now() + ttlMs });
      return originalJson(body);
    };

    next();
  };
};

