import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = {
      id: 'owner-1',
      email: 'owner@null-ai.local',
      role: 'user',
      created_at: '2026-11-01T00:00:00.000Z',
      updated_at: '2026-11-01T00:00:00.000Z',
    };
    next();
  },
}));

import { createAuthRouter } from '@/interfaces/http/controllers/auth';

const app = () => {
  const server = express();
  server.use(express.json());
  server.use('/api/auth', createAuthRouter());
  return server;
};

describe('auth router', () => {
  it('returns the local owner from GET /me', async () => {
    const res = await request(app()).get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: 'owner-1',
        email: 'owner@null-ai.local',
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
        role: 'user',
      },
    });
  });

  it('has no sign-in routes: /me is the only route under /api/auth', async () => {
    for (const path of ['/signup', '/login', '/signout', '/forgot-password', '/reset-password', '/verify-email']) {
      const res = await request(app()).post(`/api/auth${path}`).send({});
      expect(res.status, path).toBe(404);
    }
  });
});
