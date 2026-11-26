import { describe, expect, it } from 'vitest';

import { codeOccurrenceRiskState } from '@/domains/security-ops/risks/RiskDetailService';

describe('code occurrence Risk detail state', () => {
  it('presents source validation without implying global publication', () => {
    expect(codeOccurrenceRiskState('candidate')).toBe('potential');
    expect(codeOccurrenceRiskState('validated')).toBe('confirmed');
    expect(codeOccurrenceRiskState('rejected')).toBe('dismissed');
  });
});
