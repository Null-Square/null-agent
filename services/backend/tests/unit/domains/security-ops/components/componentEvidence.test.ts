import { describe, expect, it } from 'vitest';

import {
  evidenceTierForObservation,
  isInterruptEligibleEvidenceTier,
} from '@/domains/security-ops/components/componentEvidence';

describe('component evidence policy', () => {
  it.each(['connected_site', 'lockfile'] as const)(
    'treats a version from %s as authoritative observation evidence',
    (source) => {
      expect(evidenceTierForObservation(source, '1.2.3')).toBe('observed_exact');
    },
  );

  it.each(['httpx', 'agent', 'scan_preview'] as const)(
    'treats a version from %s as reported evidence',
    (source) => {
      expect(evidenceTierForObservation(source, '1.2.3')).toBe('reported_exact');
    },
  );

  it('never assigns exact evidence without a usable version', () => {
    expect(evidenceTierForObservation('connected_site', null)).toBe('absent');
    expect(evidenceTierForObservation('lockfile', '')).toBe('absent');
  });

  it('allows only authoritative observations and fresh customer attestations to interrupt', () => {
    expect(isInterruptEligibleEvidenceTier('observed_exact')).toBe(true);
    expect(isInterruptEligibleEvidenceTier('attested_exact')).toBe(true);
    expect(isInterruptEligibleEvidenceTier('reported_exact')).toBe(false);
    expect(isInterruptEligibleEvidenceTier('absent')).toBe(false);
    expect(isInterruptEligibleEvidenceTier(null)).toBe(false);
  });
});
