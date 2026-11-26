import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const makeApp = async (ttlMs = 50) => {
  vi.resetModules();
  const { idempotency } = await import('@/interfaces/http/controllers/ai-agent/middleware/idempotency');
  const app = express();
  app.use(express.json());
  let calls = 0;
  app.post('/tools', idempotency(ttlMs), (_req, res) => {
    calls += 1;
    res.status(201).json({ calls });
  });
  return { app, getCalls: () => calls };
};

describe('idempotency middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through requests without a key', async () => {
    const { app, getCalls } = await makeApp();

    const first = await request(app).post('/tools').send({}).expect(201);
    const second = await request(app).post('/tools').send({}).expect(201);

    expect(first.body.calls).toBe(1);
    expect(second.body.calls).toBe(2);
    expect(getCalls()).toBe(2);
  });

  it('replays cached responses for the same idempotency key', async () => {
    const { app, getCalls } = await makeApp();

    const first = await request(app)
      .post('/tools')
      .set('x-idempotency-key', 'k-1')
      .send({}).expect(201);
    const second = await request(app)
      .post('/tools')
      .set('x-idempotency-key', 'k-1')
      .send({}).expect(201);

    expect(first.body).toEqual({ calls: 1 });
    expect(second.body).toEqual({ calls: 1 });
    expect(getCalls()).toBe(1);
  });

  it('expires cached responses after the TTL', async () => {
    const { app, getCalls } = await makeApp(10);

    await request(app)
      .post('/tools')
      .set('x-idempotency-key', 'k-ttl')
      .send({}).expect(201);

    await new Promise((resolve) => setTimeout(resolve, 15));

    const res = await request(app)
      .post('/tools')
      .set('x-idempotency-key', 'k-ttl')
      .send({}).expect(201);

    expect(res.body.calls).toBe(2);
    expect(getCalls()).toBe(2);
  });
});
