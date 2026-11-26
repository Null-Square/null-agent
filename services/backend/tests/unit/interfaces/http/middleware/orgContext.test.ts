import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => {
  let queuedRows: unknown[][] = [];

  const limit = vi.fn(async () => queuedRows.shift() ?? []);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));

  return {
    select,
    from,
    where,
    limit,
    setRows(rows: unknown[][]) {
      queuedRows = [...rows];
    },
    reset() {
      queuedRows = [];
      select.mockClear();
      from.mockClear();
      where.mockClear();
      limit.mockClear();
    },
  };
});

const membershipMock = vi.hoisted(() => ({
  resolvePrimaryOrganizationMembership: vi.fn(),
}));

vi.mock('@/db/client', () => ({
  db: {
    select: dbMock.select,
  },
}));

vi.mock('@/shared/auth/resolveOrgMembership', () => membershipMock);

import {
  ensurePrimaryOrgContext,
  requirePrimaryOrgContext,
  requireRunnerOrgContext,
} from '@/interfaces/http/middleware/orgContext';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AuthenticatedRequest } from '@/shared/types/express';

const createReq = (overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest =>
  ({
    params: {},
    user: { id: 'user-1', email: 'user@example.com', role: 'user' },
    ...overrides,
  }) as AuthenticatedRequest;

describe('orgContext middleware', () => {
  beforeEach(() => {
    dbMock.reset();
    membershipMock.resolvePrimaryOrganizationMembership.mockReset();
  });

  it('resolves resource organization context from the requested resource', async () => {
    dbMock.setRows([[{ organizationId: 'org-resource' }], [{ role: 'viewer' }]]);
    const req = createReq({ params: { id: 'runner-1' } });
    const next = vi.fn();

    await requireRunnerOrgContext()(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-resource');
    expect(req.orgRole).toBe('viewer');
    expect(req.orgContextSource).toBe('resource');
    expect(dbMock.limit).toHaveBeenCalledTimes(2);
  });

  it('rejects when the user is not a member of the resource organization', async () => {
    dbMock.setRows([[{ organizationId: 'org-resource' }], []]);
    const req = createReq({ params: { id: 'runner-1' } });
    const next = vi.fn();

    await requireRunnerOrgContext()(req, {} as any, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const error = next.mock.calls[0]?.[0] as AppError;
    expect(error.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(req.organizationId).toBeUndefined();
  });

  it('does not use primary organization membership for resource routes', async () => {
    dbMock.setRows([[{ organizationId: 'org-resource' }], [{ role: 'analyst' }]]);
    membershipMock.resolvePrimaryOrganizationMembership.mockResolvedValue({
      organizationId: 'org-primary',
      role: 'admin',
    });
    const req = createReq({ params: { id: 'runner-1' } });
    const next = vi.fn();

    await requireRunnerOrgContext()(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-resource');
    expect(req.orgRole).toBe('analyst');
    expect(membershipMock.resolvePrimaryOrganizationMembership).not.toHaveBeenCalled();
  });

  it('uses primary organization context only for routes that explicitly request it', async () => {
    membershipMock.resolvePrimaryOrganizationMembership.mockResolvedValue({
      organizationId: 'org-primary',
      role: 'lead',
    });
    const req = createReq();
    const next = vi.fn();

    await requirePrimaryOrgContext(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-primary');
    expect(req.orgRole).toBe('lead');
    expect(req.orgContextSource).toBe('primary');
  });

  it('keeps system actors scoped to the resolved resource organization', async () => {
    dbMock.setRows([[{ organizationId: 'org-resource' }]]);
    const req = createReq({
      params: { id: 'runner-1' },
      user: { id: 'agent-internal', email: 'agent-internal@null.ai', role: 'system' },
    });
    const next = vi.fn();

    await requireRunnerOrgContext()(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-resource');
    expect(req.orgRole).toBe('admin');
    expect(req.orgContextSource).toBe('resource');
    expect(dbMock.limit).toHaveBeenCalledTimes(1);
  });

  it('gives an app or agent request the primary organization when no route set one', async () => {
    membershipMock.resolvePrimaryOrganizationMembership.mockResolvedValue({
      organizationId: 'org-primary',
      role: 'admin',
    });
    const req = createReq();
    const next = vi.fn();

    await ensurePrimaryOrgContext(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-primary');
    expect(req.orgRole).toBe('admin');
    expect(req.orgContextSource).toBe('primary');
  });

  it('keeps an organization context that is already set', async () => {
    const req = createReq({ organizationId: 'org-set', orgRole: 'viewer', orgContextSource: 'resource' });
    const next = vi.fn();

    await ensurePrimaryOrgContext(req, {} as any, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.organizationId).toBe('org-set');
    expect(req.orgRole).toBe('viewer');
    expect(membershipMock.resolvePrimaryOrganizationMembership).not.toHaveBeenCalled();
  });
});
