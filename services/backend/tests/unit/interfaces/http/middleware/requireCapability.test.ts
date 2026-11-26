import { describe, expect, it, vi } from 'vitest';

import { requireCapability } from '@/interfaces/http/middleware/requireCapability';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AuthenticatedRequest } from '@/shared/types/express';

const createReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
  ({
    user: { id: 'user-1', email: 'user@example.com', role: 'user' },
    ...overrides,
  }) as AuthenticatedRequest;

describe('requireCapability', () => {
  it('requires organization context to be resolved before checking capabilities', async () => {
    const next = vi.fn();

    await requireCapability('findings.triage')(createReq(), {} as any, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(error.message).toContain('Organization context is required');
  });

  it('allows a role with the requested capability in the resolved organization context', async () => {
    const next = vi.fn();

    await requireCapability('findings.triage')(
      createReq({
        organizationId: 'org-1',
        orgRole: 'analyst',
        orgContextSource: 'resource',
      }),
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a role that lacks the requested capability', async () => {
    const next = vi.fn();

    await requireCapability('credits.adjust')(
      createReq({
        organizationId: 'org-1',
        orgRole: 'lead',
        orgContextSource: 'primary',
      }),
      {} as any,
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(error.message).toContain('credits.adjust');
  });
});
