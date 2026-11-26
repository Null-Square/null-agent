import express, { type Application } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  API_RATE_LIMIT_POLICIES,
  createApiTrafficClassLimiters,
  resetRateLimitBuckets,
} from '@/shared/ratelimit';

const ok = (app: Application): Application => {
  app.use((_req, res) => res.json({ ok: true }));
  return app;
};

describe('API traffic-class rate limits', () => {
  beforeEach(() => resetRateLimitBuckets());

  it('gives each authenticated user an independent interactive budget', async () => {
    const limits = createApiTrafficClassLimiters();
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: String(req.get('x-test-user')) } as never;
      next();
    });
    app.use(limits.interactiveUser);
    ok(app);

    const firstA = await request(app).get('/').set('x-test-user', 'user-a');
    const firstB = await request(app).get('/').set('x-test-user', 'user-b');
    const secondA = await request(app).get('/').set('x-test-user', 'user-a');

    expect(firstA.headers['x-ratelimit-limit']).toBe(String(API_RATE_LIMIT_POLICIES.interactiveUser.max));
    expect(firstA.headers['x-ratelimit-remaining']).toBe('299');
    expect(firstB.headers['x-ratelimit-remaining']).toBe('299');
    expect(secondA.headers['x-ratelimit-remaining']).toBe('298');
  });

  it('keeps auth traffic out of the interactive user bucket', async () => {
    const limits = createApiTrafficClassLimiters();
    const auth = ok(express().use(limits.auth));
    const interactive = express();
    interactive.use((req, _res, next) => {
      req.user = { id: 'user-a' } as never;
      next();
    });
    interactive.use(limits.interactiveUser);
    ok(interactive);

    await request(auth).get('/me');
    const userRequest = await request(interactive).get('/dashboard');

    expect(userRequest.headers['x-ratelimit-remaining']).toBe('299');
  });
});

