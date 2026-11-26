import { describe, it, expect, vi } from 'vitest';
import { auth } from '@/interfaces/http/controllers/ai-agent/middleware/auth';

describe('ai-agent auth middleware', () => {
  it('passes through to next handler', () => {
    const next = vi.fn();

    auth({} as any, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
