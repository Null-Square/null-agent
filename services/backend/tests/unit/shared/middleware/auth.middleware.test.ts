import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';

vi.mock('@/shared/auth/localOwner', () => ({
  localOwner: vi.fn(),
}));

import { authMiddleware, OWNER_KEY_REQUIRED_MESSAGE } from '@/shared/middleware/auth.middleware';
import { localOwner } from '@/shared/auth/localOwner';
import { OWNER_COOKIE, ownerSessionValue } from '@/shared/auth/ownerKey';

const KEY = 'k'.repeat(43);
const OWNER = { id: 'owner-1', email: 'owner@null-ai.local', role: 'user', email_verified: true, disabled: false };

const createReq = (headers: Record<string, string> = {}, overrides: Record<string, unknown> = {}) => ({
  headers,
  query: {},
  app: { locals: { ownerKey: KEY } },
  ...overrides,
});

const refusal = (next: Mock) => {
  expect(next).toHaveBeenCalledTimes(1);
  const error = next.mock.calls[0]?.[0] as { httpStatus?: number; userMessage?: string } | undefined;
  expect(error?.httpStatus).toBe(401);
  expect(error?.userMessage).toBe(OWNER_KEY_REQUIRED_MESSAGE);
};

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (localOwner as Mock).mockResolvedValue(OWNER);
  });

  it('makes a request with the owner cookie the local owner', async () => {
    const req: any = createReq({ cookie: `other=1; ${OWNER_COOKIE}=${ownerSessionValue(KEY)}` });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual(OWNER);
  });

  it('accepts the owner key as a bearer token, for scripts', async () => {
    const req: any = createReq({ authorization: `Bearer ${KEY}` });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual(OWNER);
  });

  it('refuses a request with no key: a container on this computer is not the person', async () => {
    const req: any = createReq({ host: 'localhost' });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    refusal(next);
    expect(req.user).toBeUndefined();
    expect(localOwner).not.toHaveBeenCalled();
  });

  it('refuses a wrong cookie, a wrong bearer token, and the cookie value sent as a bearer token', async () => {
    const attempts: Array<Record<string, string>> = [
      { cookie: `${OWNER_COOKIE}=${ownerSessionValue('x'.repeat(43))}` },
      { authorization: 'Bearer guess' },
      { authorization: `Bearer ${ownerSessionValue(KEY)}` },
    ];
    for (const headers of attempts) {
      const next = vi.fn();
      const req: any = createReq(headers);
      await authMiddleware(req, {} as any, next);
      refusal(next);
      expect(req.user).toBeUndefined();
    }
  });

  it('no header makes a request the system: the old internal token grants nothing', async () => {
    const req: any = createReq({ 'x-agent-internal-token': 'agent-internal-dev-token' });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    refusal(next);
  });

  it('fails closed when the server holds no owner key', async () => {
    const req: any = createReq({ authorization: `Bearer ${KEY}` }, { app: { locals: {} } });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    refusal(next);
  });

  it('reuses authentication established by a route-tree boundary', async () => {
    const req: any = createReq({}, { user: { id: 'already', email: 'a@b.c' } });
    const next = vi.fn();

    await authMiddleware(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ id: 'already', email: 'a@b.c' });
    expect(localOwner).not.toHaveBeenCalled();
  });

  it('passes a failure to find the owner on to the error handler', async () => {
    const failure = new Error('database down');
    (localOwner as Mock).mockRejectedValue(failure);
    const next = vi.fn();

    await authMiddleware(createReq({ authorization: `Bearer ${KEY}` }) as any, {} as any, next);

    expect(next).toHaveBeenCalledWith(failure);
  });
});
