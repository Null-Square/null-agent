import { describe, expect, it } from 'vitest';
import { ntypeSchemas } from '@/domains/security-ops/tools/ntypeSchemas';

describe('validation.lead ntype schema (PRD 2.0-B §1)', () => {
  const schema = ntypeSchemas['validation.lead']!;
  const openLead = {
    source: 'openapi',
    riskFamily: 'idor',
    target: 'https://api.example.com',
    method: 'GET',
    path: '/api/orders/{orderId}',
    parameter: 'orderId',
    hypothesis: 'orderId may expose another user run without proper authorization checks.',
    status: 'open' as const,
  };

  it('accepts an open lead without observations', () => {
    const result = schema.safeParse(openLead);
    expect(result.success).toBe(true);
  });

  it('accepts a validated lead without observations (validation produced a candidate finding)', () => {
    const result = schema.safeParse({
      ...openLead,
      status: 'validated',
      candidateFindingIds: ['finding-1'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a false_positive lead with no observations', () => {
    const result = schema.safeParse({
      ...openLead,
      status: 'false_positive',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/observations/);
    }
  });

  it('rejects a deferred lead with no observations', () => {
    const result = schema.safeParse({
      ...openLead,
      status: 'deferred',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/observations/);
    }
  });

  it('accepts a false_positive lead with at least one observation', () => {
    const result = schema.safeParse({
      ...openLead,
      status: 'false_positive',
      observations: [
        {
          technique: 'sequential-id-walk',
          probe: 'http_differential id=1..5',
          result: 'contradicted',
          note: 'all 5 IDs returned 401 unauthenticated.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
