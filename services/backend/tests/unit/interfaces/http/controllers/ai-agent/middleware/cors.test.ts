import { describe, it, expect, vi } from 'vitest';
import { cors } from '@/interfaces/http/controllers/ai-agent/middleware/cors';

const buildRes = () => ({
  setHeader: vi.fn(),
  status: vi.fn().mockReturnThis(),
  end: vi.fn(),
});

describe('cors middleware', () => {
  it('sets allowed origin, credentials, and default headers', () => {
    const middleware = cors({
      origin: (value) => value === 'https://app.example',
      allowCredentials: true,
      headers: ['x-client'],
    });
    const req = {
      method: 'GET',
      header: vi.fn((name: string) => (name === 'origin' ? 'https://app.example' : undefined)),
    };
    const res = buildRes();
    const next = vi.fn();

    middleware(req as any, res as any, next);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://app.example');
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials', 'true');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'x-client');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('short-circuits OPTIONS preflight with requested headers', () => {
    const middleware = cors({ origin: ['https://app.example'] });
    const req = {
      method: 'OPTIONS',
      header: vi.fn((name: string) => {
        if (name === 'origin') return 'https://app.example';
        if (name === 'access-control-request-headers') return 'x-test';
        return undefined;
      }),
    };
    const res = buildRes();
    const next = vi.fn();

    middleware(req as any, res as any, next);

    expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'x-test');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});
