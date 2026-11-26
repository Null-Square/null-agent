import { describe, expect, it, vi } from 'vitest';

import { ValidationLeadService } from '@/domains/security-ops/tools/validation/ValidationLeadService';

const validLeadData = (overrides: Record<string, unknown> = {}) => ({
  source: 'scanner',
  riskFamily: 'xss',
  hypothesis: 'Parameter q may reflect script content.',
  status: 'open',
  ...overrides,
});

const createQuery = (rows: unknown[]) => {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return query;
};

const createUpdate = () => {
  const update = {
    set: vi.fn(() => update),
    where: vi.fn(async () => undefined),
  };
  return update;
};

const createService = (db: never, now = new Date('2026-06-12T00:00:00.000Z')) =>
  new ValidationLeadService(db, {
    now: () => now,
    normalizeToolText: (value) => value.trim(),
    buildReportNoteValidationError: (detail, ntype) => new Error(`${ntype}: ${detail}`),
    mergeEvidenceWithExcerptsByPath: (existing, incoming) => [...(existing ?? []), ...incoming],
  });

describe('ValidationLeadService', () => {
  it('updates prompt metadata and merges prompt evidence', async () => {
    const update = createUpdate();
    const db = {
      select: vi.fn(() => createQuery([
        {
          id: '11111111-1111-4111-8111-111111111111',
          data: validLeadData(),
          evidence: [{ path: '.artifacts/existing.md', label: 'existing' }],
        },
      ])),
      update: vi.fn(() => update),
    };
    const service = createService(db as never);

    const result = await service.updatePromptMetadata({
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      leadId: '11111111-1111-4111-8111-111111111111',
      promptSha256: 'a'.repeat(64),
      promptPath: '.artifacts/validation-lead.md',
      normalizedLead: {
        target: 'https://app.example.test/search',
      },
    });

    expect(result).toEqual({
      leadId: '11111111-1111-4111-8111-111111111111',
      promptSha256: 'a'.repeat(64),
      promptPath: '.artifacts/validation-lead.md',
      status: 'open',
    });
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          promptSha256: 'a'.repeat(64),
          promptPath: '.artifacts/validation-lead.md',
          promptRenderedAt: '2026-06-12T00:00:00.000Z',
        }),
        evidence: [
          { path: '.artifacts/existing.md', label: 'existing' },
          { path: '.artifacts/validation-lead.md', label: 'validation lead prompt' },
        ],
      }),
    );
  });

  it('auto-defers a validation lead after the same blocker repeats three times', async () => {
    const update = createUpdate();
    const tx = {
      select: vi
        .fn()
        .mockReturnValueOnce(createQuery([
          {
            id: '22222222-2222-4222-8222-222222222222',
            data: validLeadData({
              status: 'blocked',
              promptSha256: 'b'.repeat(64),
              attempts: 2,
              lastCanonicalBlockerCode: 'rate_limited',
              blockerRepeatCount: 2,
              observations: [],
            }),
          },
        ]))
        .mockReturnValueOnce(createQuery([
          {
            id: '33333333-3333-4333-8333-333333333333',
            data: validLeadData({ status: 'open' }),
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            data: validLeadData({ status: 'deferred' }),
          },
        ])),
      update: vi.fn(() => update),
    };
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const service = createService(db as never);

    const result = await service.submitOutcome({
      userId: 'user-1',
      organizationId: 'org-1',
      scopeId: 'scope-1',
      input: {
        leadId: '22222222-2222-4222-8222-222222222222',
        promptSha256: 'b'.repeat(64),
        outcome: 'blocked',
        blockerCode: 'HTTP 429 throttled',
      },
    });

    expect(result).toMatchObject({
      leadId: '22222222-2222-4222-8222-222222222222',
      outcome: 'deferred',
      requestedOutcome: 'blocked',
      canonicalBlockerCode: 'rate_limited',
      attempts: 3,
      autoDeferred: true,
      remainingOpenLeadIds: ['33333333-3333-4333-8333-333333333333'],
    });
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'deferred',
          attempts: 3,
          blockerRepeatCount: 3,
          observations: [
            expect.objectContaining({
              technique: 'blocked_prerequisite',
              result: 'inconclusive',
            }),
          ],
        }),
      }),
    );
  });
});
