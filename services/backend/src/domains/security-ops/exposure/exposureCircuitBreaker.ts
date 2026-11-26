/**
 * Alert-volume circuit breaker.
 *
 * Threat Watch fails in one direction far worse than the other. A missed alert
 * is invisible and costs one customer one incident; a runaway alert storm hits
 * every customer at once, is highly visible, and burns the trust the whole
 * product runs on. A single bad NVD day, an over-broad alias mapping, or a
 * matcher regression could each produce one.
 *
 * So volume is treated as a signal in its own right: past a threshold, the
 * correct response is to stop alerting and page ourselves, not to keep sending.
 * Matches are still recorded — they appear on the dashboard and in the digest —
 * only the interrupt channel is held.
 *
 * Pure and dependency-free so the thresholds can be reasoned about and tested
 * directly, rather than inferred from a production incident.
 */

export type CircuitBreakerThresholds = {
  /** Interrupt-grade matches for one organization in a single cycle. */
  perOrganization: number;
  /** Interrupt-grade matches across all organizations in a single cycle. */
  global: number;
};

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLDS: CircuitBreakerThresholds = {
  // A real customer receiving more than a handful of genuine interrupt-grade
  // exposures in one cycle is itself worth a human look before we send.
  perOrganization: 10,
  global: 250,
};

export type CircuitBreakerDecision =
  | { tripped: false }
  | {
      tripped: true;
      scope: 'organization' | 'global';
      organizationId?: string;
      observed: number;
      threshold: number;
      reason: string;
    };

/**
 * Decide whether alerting may proceed for this cycle.
 *
 * Per-organization is checked before global: a single tenant blowing up is the
 * more common failure and names the culprit precisely, which makes the ops
 * alert actionable rather than merely alarming.
 */
export const evaluateCircuitBreaker = (params: {
  interruptGradeByOrganization: ReadonlyMap<string, number>;
  thresholds?: CircuitBreakerThresholds;
}): CircuitBreakerDecision => {
  const thresholds = params.thresholds ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLDS;

  let total = 0;
  let worstOrganizationId: string | null = null;
  let worstCount = 0;

  for (const [organizationId, count] of params.interruptGradeByOrganization) {
    total += count;
    if (count > worstCount) {
      worstCount = count;
      worstOrganizationId = organizationId;
    }
  }

  if (worstOrganizationId && worstCount > thresholds.perOrganization) {
    return {
      tripped: true,
      scope: 'organization',
      organizationId: worstOrganizationId,
      observed: worstCount,
      threshold: thresholds.perOrganization,
      reason:
        `Organization ${worstOrganizationId} would receive ${worstCount} interrupt-grade alerts ` +
        `in one cycle (threshold ${thresholds.perOrganization}). Alerting held pending review.`,
    };
  }

  if (total > thresholds.global) {
    return {
      tripped: true,
      scope: 'global',
      observed: total,
      threshold: thresholds.global,
      reason:
        `${total} interrupt-grade alerts would be sent across all organizations in one cycle ` +
        `(threshold ${thresholds.global}). Alerting held pending review.`,
    };
  }

  return { tripped: false };
};
