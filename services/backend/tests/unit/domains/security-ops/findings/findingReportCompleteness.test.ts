import { describe, expect, it } from 'vitest';

import { buildFindingReportCompleteness } from '@/domains/security-ops/findings/findingReportCompleteness';

describe('buildFindingReportCompleteness', () => {
  it('marks empty final-report narrative fields as blockers', () => {
    const result = buildFindingReportCompleteness({
      id: 'finding-1',
      title: 'IDOR candidate',
      businessImpact: '',
      technicalAnalysis: '   ',
      pocDescription: null,
      assumptions: undefined,
      remediation: '',
      fixEffort: null,
      cweIds: null,
      cweId: null,
      owaspCategory: null,
      cvssScore: null,
      cvssVector: null,
    });

    expect(result.canFinalizeReportable).toBe(false);
    expect(result.missingReportFields).toEqual([
      'businessImpact',
      'technicalAnalysis',
      'pocDescription',
      'assumptions',
      'remediation',
    ]);
    expect(result.advisoryMissingFields).toEqual(['fixEffort', 'cweIds', 'cvss', 'owaspCategory']);
    expect(result.repairInstruction).toContain('validatesFindingId="finding-1"');
  });

  it('flags only the missing subset when some P0 fields are present', () => {
    // Partial case: proves the policy detects a subset, not just all-or-nothing.
    const result = buildFindingReportCompleteness({
      id: 'finding-2',
      title: 'Partial finding',
      businessImpact: 'Cross-account order disclosure affects customer privacy.',
      technicalAnalysis: 'Ownership is not enforced before returning the record.',
      pocDescription: '   ', // whitespace-only -> still missing
      assumptions: 'Attacker has any valid account.',
      remediation: '', // empty -> missing
      fixEffort: 'low',
    });

    expect(result.canFinalizeReportable).toBe(false);
    expect(result.missingReportFields).toEqual(['pocDescription', 'remediation']);
    expect(result.advisoryMissingFields).not.toContain('fixEffort');
    expect(result.repairInstruction).toContain('validatesFindingId="finding-2"');
  });

  it('does not block finalization for advisory-only missing fields', () => {
    const result = buildFindingReportCompleteness({
      id: 'finding-1',
      title: 'IDOR candidate',
      businessImpact: 'Cross-account order disclosure affects customer privacy.',
      technicalAnalysis: 'The order read path does not enforce ownership before returning records.',
      pocDescription: 'Request two order IDs from the same account and observe the cross-account response.',
      assumptions: 'Attacker has any valid account and can guess order identifiers.',
      remediation: 'Enforce ownership checks and return 403 for cross-account reads.',
      fixEffort: null,
      cweIds: null,
      owaspCategory: null,
      cvssScore: null,
      cvssVector: null,
    });

    expect(result.canFinalizeReportable).toBe(true);
    expect(result.missingReportFields).toEqual([]);
    expect(result.advisoryMissingFields).toEqual(['fixEffort', 'cweIds', 'cvss', 'owaspCategory']);
    expect(result.repairInstruction).toBeUndefined();
  });
});
