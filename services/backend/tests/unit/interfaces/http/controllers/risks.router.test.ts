import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError, ERROR_CODES } from '@/shared/errors';
import { createRisksRouter } from '@/interfaces/http/controllers/risks.router';

const scopeId = '77215a67-bfdd-4df1-ab69-42a838c2ce91';
const riskId = '13ea75c5-0a06-4bec-82e4-52ef6dc7684c';
const occurrenceId = 'f20b8834-1034-4e3f-a418-6f89efc0bcc4';

describe('risks router', () => {
  const resolveOrganizationSubscription = vi.fn();
  const enforceCodeReviewAccess = vi.fn();
  const read = vi.fn();
  const readDetail = vi.fn();
  const readCodeOccurrence = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resolveOrganizationSubscription.mockResolvedValue({
      plan: { features: { accessThreatWatch: true, accessCodeReview: true } },
    });
    enforceCodeReviewAccess.mockResolvedValue(undefined);
    read.mockResolvedValue({
      risks: [{ key: 'finding:1', id: '1', recordKind: 'finding' }],
      summary: {
        total: 1,
        open: 1,
        openKev: 0,
        byState: { potential: 1 },
        bySeverity: { high: 1 },
        openBySeverity: { high: 1 },
      },
    });
    readDetail.mockResolvedValue({ id: riskId, sourceKind: 'code_review' });
    readCodeOccurrence.mockResolvedValue({
      detailKind: 'code_occurrence',
      id: occurrenceId,
      canonicalRiskId: null,
      sourceKind: 'code_review',
    });
  });

  const handler = () => {
    const router = createRisksRouter({
      accessControl: { resolveOrganizationSubscription, enforceCodeReviewAccess },
      reader: { read },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/');
    return layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
  };

  const response = () => ({
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  });

  const detailHandler = () => {
    const router = createRisksRouter({
      accessControl: { resolveOrganizationSubscription, enforceCodeReviewAccess },
      reader: { read },
      detailReader: { read: readDetail, readCodeOccurrence },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/:id');
    return layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
  };

  const occurrenceHandler = () => {
    const router = createRisksRouter({
      accessControl: { resolveOrganizationSubscription, enforceCodeReviewAccess },
      reader: { read },
      detailReader: { read: readDetail, readCodeOccurrence },
    });
    const layer = router.stack.find((candidate) => candidate.route?.path === '/code-occurrences/:id');
    return layer?.route?.stack.at(-1)?.handle as unknown as (
      req: object,
      res: object,
      next: () => void,
    ) => Promise<void>;
  };

  it('returns one read model for the requested scope', async () => {
    const res = response();

    await handler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        query: { scopeId },
      },
      res,
      vi.fn(),
    );

    expect(read).toHaveBeenCalledWith({
      organizationId: 'org-1',
      scopeId,
      includeExposures: true,
    });
    expect(res.json).toHaveBeenCalledWith({
      risks: [{ key: 'finding:1', id: '1', recordKind: 'finding' }],
      summary: expect.objectContaining({ total: 1, open: 1 }),
    });
  });

  it('keeps findings but omits exposure rows when the plan has no Threat Watch access', async () => {
    resolveOrganizationSubscription.mockResolvedValue({
      plan: { features: { accessThreatWatch: false } },
    });
    const res = response();

    await handler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        query: { scopeId },
      },
      res,
      vi.fn(),
    );

    expect(read).toHaveBeenCalledWith(expect.objectContaining({ includeExposures: false }));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an invalid scope before resolving access or reading data', async () => {
    const res = response();

    await handler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        query: { scopeId: 'not-a-uuid' },
      },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(resolveOrganizationSubscription).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps stored code Risks readable while restricting source detail after a plan downgrade', async () => {
    resolveOrganizationSubscription.mockResolvedValue({
      plan: { features: { accessThreatWatch: false, accessCodeReview: false } },
    });
    const res = response();

    await detailHandler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        params: { id: riskId },
      },
      res,
      vi.fn(),
    );

    expect(readDetail).toHaveBeenCalledWith({
      organizationId: 'org-1',
      riskId,
      includeCodeSource: false,
      includeExposureSource: false,
    });
    expect(res.json).toHaveBeenCalledWith({ id: riskId, sourceKind: 'code_review' });
  });

  it('loads an unpublished occurrence only after enforcing Code Review access', async () => {
    const res = response();

    await occurrenceHandler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        params: { id: occurrenceId },
      },
      res,
      vi.fn(),
    );

    expect(enforceCodeReviewAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(readCodeOccurrence).toHaveBeenCalledWith({
      organizationId: 'org-1',
      occurrenceId,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      detailKind: 'code_occurrence',
      canonicalRiskId: null,
    }));
  });

  it('rejects an invalid occurrence id before checking plan access', async () => {
    const res = response();

    await occurrenceHandler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        params: { id: 'not-a-uuid' },
      },
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(enforceCodeReviewAccess).not.toHaveBeenCalled();
    expect(readCodeOccurrence).not.toHaveBeenCalled();
  });

  it('does not read an occurrence when Code Review access is denied', async () => {
    enforceCodeReviewAccess.mockRejectedValueOnce(new AppError(
      ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE,
      'Code Review is not available',
      { httpStatus: 403 },
    ));
    const res = response();

    await occurrenceHandler()(
      {
        user: { id: 'user-1' },
        organizationId: 'org-1',
        orgRole: 'viewer',
        params: { id: occurrenceId },
      },
      res,
      vi.fn(),
    );

    expect(enforceCodeReviewAccess).toHaveBeenCalledOnce();
    expect(readCodeOccurrence).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
