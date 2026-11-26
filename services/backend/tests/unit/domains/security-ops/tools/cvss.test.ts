import { describe, expect, it } from 'vitest';

import { calculateCvss } from '@/domains/security-ops/tools/cvss';

describe('calculateCvss', () => {
  it('calculates expected base score and vector for a critical finding', () => {
    const result = calculateCvss({
      attackVector: 'N',
      attackComplexity: 'L',
      privilegesRequired: 'N',
      userInteraction: 'N',
      scope: 'U',
      confidentiality: 'H',
      integrity: 'H',
      availability: 'H',
    });

    expect(result.score).toBeCloseTo(9.8, 1);
    expect(result.severity).toBe('critical');
    expect(result.vector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
  });

  it('returns score 0 and severity none when impact is none', () => {
    const result = calculateCvss({
      attackVector: 'N',
      attackComplexity: 'L',
      privilegesRequired: 'N',
      userInteraction: 'N',
      scope: 'U',
      confidentiality: 'N',
      integrity: 'N',
      availability: 'N',
    });

    expect(result.score).toBe(0);
    expect(result.severity).toBe('none');
  });
});

