import { describe, expect, it } from 'vitest';

import { assertReportingClassificationStable } from '@/domains/security-ops/findings/FindingReportService';

describe('FindingReportService reporting classification boundary', () => {
  it('accepts report repair fields when severity and CVSS still agree with validation', () => {
    expect(() => assertReportingClassificationStable({
      existingSeverity: 'low',
      incomingSeverity: 'low',
      calculatedCvssSeverity: 'low',
    })).not.toThrow();
  });

  it('rejects a reporting-only severity increase', () => {
    expect(() => assertReportingClassificationStable({
      existingSeverity: 'low',
      incomingSeverity: 'medium',
    })).toThrow(/cannot change validated severity from low to medium/u);
  });

  it('rejects a CVSS vector whose class disagrees with validated severity', () => {
    expect(() => assertReportingClassificationStable({
      existingSeverity: 'info',
      incomingSeverity: 'info',
      calculatedCvssSeverity: 'medium',
    })).toThrow(/cannot attach CVSS severity medium to a validated info Risk/u);
  });
});
