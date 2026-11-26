import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import { allowedHosts, createLocalHostOnly } from '@/interfaces/http/middleware/localHostOnly';

const call = (headers: Record<string, string>, env: NodeJS.ProcessEnv = {}) => {
  const door = createLocalHostOnly(allowedHosts(env));
  const next = vi.fn() as unknown as NextFunction;
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
  door({ headers } as Request, res, next);
  return { passed: (next as unknown as ReturnType<typeof vi.fn>).mock.calls.length === 1, res, json };
};

describe('localHostOnly', () => {
  it('lets in requests addressed to this computer', () => {
    for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001', 'app.localhost:8081', 'host.docker.internal:3001']) {
      expect(call({ host }).passed, host).toBe(true);
    }
  });

  it('lets in the app’s own pages on any local port', () => {
    expect(call({ host: 'localhost:3001', origin: 'http://localhost:8081' }).passed).toBe(true);
    expect(call({ host: 'localhost:3001', origin: 'http://127.0.0.1:8081' }).passed).toBe(true);
  });

  it('refuses a name that only points at this computer (DNS rebinding)', () => {
    const { passed, res } = call({ host: 'attacker.example:3001' });
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses a page on another site posting to the app', () => {
    expect(call({ host: 'localhost:3001', origin: 'https://evil.example' }).passed).toBe(false);
    expect(call({ host: 'localhost:3001', origin: 'https://www.nullsquare.net' }).passed).toBe(false);
    expect(call({ host: 'localhost:3001', origin: 'null' }).passed).toBe(false);
  });

  it('refuses a request with no Host', () => {
    expect(call({}).passed).toBe(false);
  });

  it('lets in a host the person named', () => {
    expect(call({ host: 'nullbox:3001' }).passed).toBe(false);
    expect(call({ host: 'nullbox:3001' }, { NULL_AI_ALLOWED_HOSTS: 'nullbox, other' }).passed).toBe(true);
  });
});
