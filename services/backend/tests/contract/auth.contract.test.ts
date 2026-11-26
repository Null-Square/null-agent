import { vi, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createTestServer } from '../unit/helpers/testAppHarness.helper';

vi.mock('@/shared/middleware/auth.middleware', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => {
    _req.user = { id: 'u-auth', email: 'user@test.com', role: 'user', created_at: '2024-01-01', updated_at: '2024-01-02' };
    next();
  },
}));

describe('HTTP contracts - auth', () => {
  it('me: 200 returns the local owner', async () => {
    const { server, close } = createTestServer();
    const res = await request(server).get('/api/auth/me');
    await close();

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('user@test.com');
  });

  it('has no sign-in: signup, login and signout are not routes', async () => {
    const { server, close } = createTestServer();
    const signup = await request(server).post('/api/auth/signup').send({ email: 'a@b.co', password: 'secret12' });
    const login = await request(server).post('/api/auth/login').send({ email: 'a@b.co', password: 'secret12' });
    const signout = await request(server).post('/api/auth/signout').send({});
    await close();

    expect(signup.status).toBe(404);
    expect(login.status).toBe(404);
    expect(signout.status).toBe(404);
  });
});
