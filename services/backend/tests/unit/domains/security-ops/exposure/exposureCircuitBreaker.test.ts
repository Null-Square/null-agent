import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLDS,
  evaluateCircuitBreaker,
} from '@/domains/security-ops/exposure/exposureCircuitBreaker';

const counts = (entries: Record<string, number>) => new Map(Object.entries(entries));

describe('evaluateCircuitBreaker', () => {
  it('allows a normal cycle through', () => {
    expect(
      evaluateCircuitBreaker({ interruptGradeByOrganization: counts({ 'org-1': 2, 'org-2': 1 }) }),
    ).toEqual({ tripped: false });
  });

  it('allows a cycle with nothing to send', () => {
    expect(evaluateCircuitBreaker({ interruptGradeByOrganization: counts({}) })).toEqual({
      tripped: false,
    });
  });

  it('allows a count exactly at the threshold', () => {
    expect(
      evaluateCircuitBreaker({
        interruptGradeByOrganization: counts({
          'org-1': DEFAULT_CIRCUIT_BREAKER_THRESHOLDS.perOrganization,
        }),
      }),
    ).toEqual({ tripped: false });
  });

  it('trips when one organization would be flooded', () => {
    const decision = evaluateCircuitBreaker({
      interruptGradeByOrganization: counts({ 'org-1': 1, 'org-2': 40 }),
    });

    expect(decision).toMatchObject({
      tripped: true,
      scope: 'organization',
      organizationId: 'org-2',
      observed: 40,
    });
  });

  it('names the worst organization so the ops alert is actionable', () => {
    const decision = evaluateCircuitBreaker({
      interruptGradeByOrganization: counts({ 'org-1': 15, 'org-2': 40 }),
    });

    expect(decision).toMatchObject({ organizationId: 'org-2' });
    if (decision.tripped) expect(decision.reason).toContain('org-2');
  });

  it('trips globally when many organizations are each below their own limit', () => {
    // The failure a per-tenant check alone would miss: a bad feed day spread
    // thinly across every customer.
    const spread: Record<string, number> = {};
    for (let index = 0; index < 100; index += 1) spread[`org-${index}`] = 5;

    expect(evaluateCircuitBreaker({ interruptGradeByOrganization: counts(spread) })).toMatchObject({
      tripped: true,
      scope: 'global',
      observed: 500,
    });
  });

  it('reports the organization scope first when both would trip', () => {
    const spread: Record<string, number> = { 'org-loud': 400 };
    for (let index = 0; index < 50; index += 1) spread[`org-${index}`] = 5;

    expect(evaluateCircuitBreaker({ interruptGradeByOrganization: counts(spread) })).toMatchObject({
      scope: 'organization',
      organizationId: 'org-loud',
    });
  });

  it('honours custom thresholds', () => {
    expect(
      evaluateCircuitBreaker({
        interruptGradeByOrganization: counts({ 'org-1': 3 }),
        thresholds: { perOrganization: 2, global: 1000 },
      }),
    ).toMatchObject({ tripped: true, scope: 'organization', threshold: 2 });
  });
});
