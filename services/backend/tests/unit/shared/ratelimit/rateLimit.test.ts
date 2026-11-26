import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Application, type RequestHandler } from 'express';
import request from 'supertest';
import { rateLimit, resetRateLimitBuckets, rateLimitBucketCount } from '@/shared/ratelimit';
import { RATE_LIMIT_CLEANUP_MS } from '@/config/timeouts';
import { ERROR_CODES } from '@null-ai/contracts';

/** App that runs the given middleware then always answers 200. */
const appWith = (...middleware: RequestHandler[]): Application => {
  const app = express();
  middleware.forEach((mw) => app.use(mw));
  app.use((_req, res) => {
    res.json({ ok: true });
  });
  return app;
};

const remainingAfter = async (app: Application, calls: number): Promise<string | undefined> => {
  let last: string | undefined;
  for (let i = 0; i < calls; i += 1) {
    last = (await request(app).get('/anything')).headers['x-ratelimit-remaining'];
  }
  return last;
};

describe('rateLimit', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('bucket namespacing', () => {
    it('keeps counters separate for limiters with different names', async () => {
      const appTraffic = appWith(rateLimit({ name: 'app', max: 10 }));
      const agentTraffic = appWith(rateLimit({ name: 'agent', max: 10 }));

      await remainingAfter(agentTraffic, 4);

      // Spending the agent budget must not move the app budget.
      expect(await remainingAfter(appTraffic, 1)).toBe('9');
    });

    it('shares a counter for limiters that opt into the same name', async () => {
      const first = appWith(rateLimit({ name: 'shared', max: 10 }));
      const second = appWith(rateLimit({ name: 'shared', max: 10 }));

      await remainingAfter(first, 3);

      expect(await remainingAfter(second, 1)).toBe('6');
    });

    it('gives unnamed limiters separate counters', async () => {
      // Regression: both limiters below used to key on the bare client IP and
      // increment one shared number, so agent traffic drained the app budget
      // while each was checked against its own, different, ceiling.
      const unnamedA = appWith(rateLimit({ max: 10 }));
      const unnamedB = appWith(rateLimit({ max: 10 }));

      await remainingAfter(unnamedB, 5);

      expect(await remainingAfter(unnamedA, 1)).toBe('9');
    });
  });

  describe('counting', () => {
    it('counts each request once', async () => {
      const app = appWith(rateLimit({ name: 'once', max: 10 }));

      expect(await remainingAfter(app, 1)).toBe('9');
      expect(await remainingAfter(app, 1)).toBe('8');
    });

    it('counts twice when the same limiter is mounted twice on one path', async () => {
      // Documents the Express footgun this design guards against: middleware
      // runs once per matching mount, so gating both a prefix and its
      // sub-paths halves the effective budget. httpServer mounts each limiter
      // once per tree for exactly this reason.
      const limiter = rateLimit({ name: 'doubled', max: 10 });
      const app = appWith(limiter, limiter);

      expect(await remainingAfter(app, 1)).toBe('8');
    });
  });

  describe('rejection', () => {
    it('rejects with 429 and retry metadata once max is exceeded', async () => {
      const app = appWith(rateLimit({ name: 'reject', max: 2 }));

      const first = await request(app).get('/anything');
      const second = await request(app).get('/anything');
      const third = await request(app).get('/anything');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.body.code).toBe(ERROR_CODES.AUTH_RATE_LIMITED_USER);
      expect(third.headers['x-ratelimit-limit']).toBe('2');
      expect(third.headers['x-ratelimit-remaining']).toBe('0');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('rejects at max + 1, not earlier', async () => {
      const app = appWith(rateLimit({ name: 'ceiling', max: 20 }));

      let sent = 0;
      let status = 200;
      while (status !== 429 && sent < 100) {
        sent += 1;
        status = (await request(app).get('/anything')).status;
      }

      expect(sent).toBe(21);
    });
  });

  describe('windowing', () => {
    it('starts a fresh window after the current one expires', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const app = appWith(rateLimit({ name: 'window', max: 2, windowMs: 1_000 }));

      await request(app).get('/anything');
      await request(app).get('/anything');
      expect((await request(app).get('/anything')).status).toBe(429);

      vi.advanceTimersByTime(1_001);

      expect((await request(app).get('/anything')).status).toBe(200);
    });
  });

  describe('memory', () => {
    it('sweeps expired buckets instead of growing forever', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      // One bucket per distinct caller; without a sweep every caller the
      // process ever sees keeps an entry for its lifetime.
      const app = appWith(
        rateLimit({
          name: 'sweep',
          max: 10,
          windowMs: 1_000,
          keyGenerator: (req) => String(req.query.caller ?? 'anonymous'),
        }),
      );

      for (let caller = 0; caller < 5; caller += 1) {
        await request(app).get('/anything').query({ caller });
      }
      expect(rateLimitBucketCount()).toBe(5);

      // Past both the window and the sweep interval, the next request should
      // clear the stale entries and leave only its own.
      vi.advanceTimersByTime(RATE_LIMIT_CLEANUP_MS + 1_000);
      await request(app).get('/anything').query({ caller: 'late' });

      expect(rateLimitBucketCount()).toBe(1);
    });
  });
});
