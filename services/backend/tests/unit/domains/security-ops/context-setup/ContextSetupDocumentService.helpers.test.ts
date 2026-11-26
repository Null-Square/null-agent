import { describe, expect, it } from 'vitest';

import {
  buildOrgFallbackDocument,
  buildRoeFallbackDocument,
  hasMeaningfulOrgAnswers,
  hasMeaningfulRoeAnswers,
} from '@/domains/security-ops/context-setup/ContextSetupDocumentService';

describe('context-setup helpers', () => {
  it('builds deterministic fallback documents', () => {
    const orgFallback = buildOrgFallbackDocument({
      businessContext: 'B2C fintech, EU market',
      sensitiveDataTypes: ['PCI', 'PII'],
      sensitiveDataWhere: '/api/payments, /api/users',
      compliance: ['PCI-DSS', 'GDPR'],
      hardNoActions: 'No DoS or destructive testing',
      escalationContact: 'security@example.com',
      escalationSla: 'Immediately',
    });

    expect(orgFallback).toContain('Business Context: B2C fintech, EU market');
    expect(orgFallback).toContain('Sensitive Data: PCI, PII | /api/payments, /api/users');
    expect(orgFallback).toContain('Compliance: PCI-DSS, GDPR');
    expect(orgFallback).toContain("Hard No's: No DoS or destructive testing | Escalation: security@example.com (Immediately)");

    const roeFallback = buildRoeFallbackDocument({
      excludedServices: ['Stripe'],
      excludedPaths: '/admin/*',
      forbiddenTechniques: 'No brute-force',
      priorKnowledge: 'Auth flow rewritten last week',
      operatorNotes: 'Use synthetic accounts only',
    });

    expect(roeFallback).toContain('Specific Exclusions: /admin/* | Stripe');
    expect(roeFallback).toContain('Forbidden Techniques: No brute-force');
    expect(roeFallback).toContain('Prior Knowledge: Auth flow rewritten last week');
    expect(roeFallback).toContain('Operator Notes: Use synthetic accounts only');
  });

  it('detects whether answers contain meaningful content', () => {
    expect(
      hasMeaningfulOrgAnswers({
        businessContext: '  ',
        sensitiveDataTypes: [],
      }),
    ).toBe(false);
    expect(
      hasMeaningfulOrgAnswers({
        businessContext: 'B2C fintech',
      }),
    ).toBe(true);

    expect(
      hasMeaningfulRoeAnswers({
        excludedServices: [],
        operatorNotes: ' ',
      }),
    ).toBe(false);
    expect(
      hasMeaningfulRoeAnswers({
        excludedPaths: '/admin/*',
      }),
    ).toBe(true);
  });
});
