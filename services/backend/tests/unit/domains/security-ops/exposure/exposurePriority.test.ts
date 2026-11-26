import { describe, expect, it } from 'vitest';

import {
  calculateExposurePriority,
  isInterruptGrade,
  type ExposurePriorityInput,
} from '@/domains/security-ops/exposure/exposurePriority';

const base: ExposurePriorityInput = {
  kevListed: false,
  epssPercentile: null,
  cvssScore: null,
  matchConfidence: 'exact_version',
  backportRisk: false,
  versionConflict: false,
  evidenceAgeDays: 0,
};

const score = (over: Partial<ExposurePriorityInput> = {}) =>
  calculateExposurePriority({ ...base, ...over });

describe('calculateExposurePriority', () => {
  it('ranks known-exploited above theoretically-severe', () => {
    // The opinion this scoring encodes: a medium-CVSS bug on CISA's exploited
    // list is a worse Tuesday than a critical-CVSS bug nobody has weaponised.
    const knownExploited = score({ kevListed: true, cvssScore: 5.0 });
    const theoreticallyCritical = score({ kevListed: false, cvssScore: 9.8 });
    expect(knownExploited).toBeGreaterThan(theoreticallyCritical);
  });

  it('increases with CVSS', () => {
    expect(score({ cvssScore: 9.8 })).toBeGreaterThan(score({ cvssScore: 4.0 }));
  });

  it('increases with exploitation likelihood', () => {
    expect(score({ epssPercentile: 0.95 })).toBeGreaterThan(score({ epssPercentile: 0.05 }));
  });

  it('discounts matches whose version may not reflect what runs', () => {
    const clean = score({ cvssScore: 9.0 });
    expect(score({ cvssScore: 9.0, backportRisk: true })).toBeLessThan(clean);
    expect(score({ cvssScore: 9.0, versionConflict: true })).toBeLessThan(clean);
  });

  it('decays as evidence ages', () => {
    const fresh = score({ cvssScore: 9.8, evidenceAgeDays: 0 });
    const middling = score({ cvssScore: 9.8, evidenceAgeDays: 30 });
    const old = score({ cvssScore: 9.8, evidenceAgeDays: 90 });

    expect(middling).toBeLessThan(fresh);
    expect(old).toBeLessThan(middling);
    // Decay, not erasure: an old critical still outranks a fresh trivial one.
    expect(old).toBeGreaterThan(score({ cvssScore: 1.0, evidenceAgeDays: 0 }));
  });

  it('does not decay within the first week', () => {
    expect(score({ cvssScore: 9.8, evidenceAgeDays: 7 })).toBe(
      score({ cvssScore: 9.8, evidenceAgeDays: 0 }),
    );
  });

  it('stays within the evidence-only 0 to 90 range at the extremes', () => {
    const max = score({
      kevListed: true,
      epssPercentile: 1,
      cvssScore: 10,
    });
    expect(max).toBe(90);
  });

  it('is deterministic', () => {
    const input = { cvssScore: 7.5, epssPercentile: 0.4, kevListed: true };
    expect(score(input)).toBe(score(input));
  });
});

describe('isInterruptGrade', () => {
  const gate = (over: Partial<Parameters<typeof isInterruptGrade>[0]> = {}) =>
    isInterruptGrade({
      matchConfidence: 'exact_version',
      severity: 'critical',
      kevListed: false,
      backportRisk: false,
      versionConflict: false,
      verified: false,
      evidenceAgeDays: 1,
      stalenessThresholdDays: 14,
      ...over,
    });

  it('allows a fresh critical exact-version match', () => {
    expect(gate()).toBe(true);
  });

  it('allows high severity', () => {
    expect(gate({ severity: 'high' })).toBe(true);
  });

  it('blocks medium and low severity', () => {
    expect(gate({ severity: 'medium' })).toBe(false);
    expect(gate({ severity: 'low' })).toBe(false);
  });

  it('allows a KEV listing at any severity', () => {
    expect(gate({ severity: 'medium', kevListed: true })).toBe(true);
  });

  it('never interrupts on a version we could not read', () => {
    // The type system no longer admits this value, but rows arrive from the
    // database rather than from the compiler. The guard is the last defence if
    // a grade is ever reintroduced upstream, so it stays under test.
    expect(
      gate({ matchConfidence: 'version_absent' as never, kevListed: true }),
    ).toBe(false);
  });

  it('never interrupts on evidence past the staleness threshold', () => {
    expect(gate({ evidenceAgeDays: 20, stalenessThresholdDays: 14 })).toBe(false);
  });

  it('requires verification when a backported fix may hide the truth', () => {
    // Debian and RHEL patch without renumbering, so the version string alone
    // cannot settle it — only actually testing can.
    expect(gate({ backportRisk: true })).toBe(false);
    expect(gate({ backportRisk: true, verified: true })).toBe(true);
  });

  it('requires verification when observations disagreed on the version', () => {
    expect(gate({ versionConflict: true })).toBe(false);
    expect(gate({ versionConflict: true, verified: true })).toBe(true);
  });

  it('blocks an unknown severity that is not KEV-listed', () => {
    expect(gate({ severity: null })).toBe(false);
  });
});
