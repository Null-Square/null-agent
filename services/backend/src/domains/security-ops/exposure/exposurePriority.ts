import type { ExposureMatchConfidence } from '@/db/schema';

/**
 * Deterministic priority for an exposure match.
 *
 * Deliberately not an LLM call and deliberately not a black box: this number
 * orders what a customer sees first and gates which matches are allowed to
 * interrupt them, so it has to be explainable to someone disputing an alert.
 * Every term below is a fact we hold, not a judgement we inferred.
 *
 * Scored 0–90. The weights encode one opinion, stated plainly: *evidence of
 * real-world exploitation outranks theoretical severity*. A medium-CVSS bug on
 * CISA's exploited list is a worse Tuesday than a critical-CVSS bug nobody has
 * ever weaponised.
 */

export type ExposurePriorityInput = {
  kevListed: boolean;
  /** EPSS percentile, 0–1. Probability the CVE is exploited in the wild. */
  epssPercentile: number | null;
  /** CVSS v3.1 base score, 0–10. */
  cvssScore: number | null;
  matchConfidence: ExposureMatchConfidence;
  /** Distro packaging may hide a backported fix, so the match is less certain. */
  backportRisk: boolean;
  /** Observations disagreed on the version. */
  versionConflict: boolean;
  /** Days since the component was last confirmed present. */
  evidenceAgeDays: number;
};

const WEIGHTS = {
  /** Known exploited. The single strongest signal we have. */
  kev: 30,
  /** Exploitation likelihood in the wild. */
  epss: 20,
  /** Theoretical severity. */
  cvss: 25,
  /** Whether we could actually read a version. */
  confidence: 15,
} as const;

/**
 * Evidence decay — applied to what we believe, never to what is true.
 *
 * The split matters. An advisory's severity, its KEV listing and its EPSS score
 * are facts about the world and do not get less true because we last looked at
 * the customer's site six weeks ago. What ages is our *belief* that they still
 * run the affected component.
 *
 * Decaying the whole score conflated the two, and produced a genuinely wrong
 * ordering: a 90-day-old critical sorted below a freshly-observed trivial one,
 * which is exactly backwards for someone triaging a queue. Staleness still
 * stops an interrupt — `isInterruptGrade` blocks it outright — but it must not
 * bury a severe finding on the dashboard.
 */
const freshnessMultiplier = (evidenceAgeDays: number): number => {
  if (evidenceAgeDays <= 7) return 1;
  if (evidenceAgeDays >= 60) return 0.5;
  return 1 - ((evidenceAgeDays - 7) / (60 - 7)) * 0.5;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const calculateExposurePriority = (input: ExposurePriorityInput): number => {
  // Facts about the advisory. These do not age.
  let threatScore = 0;

  if (input.kevListed) threatScore += WEIGHTS.kev;

  if (input.epssPercentile !== null) {
    threatScore += WEIGHTS.epss * clamp01(input.epssPercentile);
  }

  if (input.cvssScore !== null) {
    threatScore += WEIGHTS.cvss * clamp01(input.cvssScore / 10);
  }

  // Facts about our knowledge of the customer's system. These do age.
  let beliefScore = 0;

  // A match we can defend outranks one we merely suspect. A match only
  // exists when a version was read, so this is the only confidence there is;
  // the branch stays explicit so a future grade must decide its own weight.
  if (input.matchConfidence === 'exact_version') {
    let confidence = 1;
    // Both of these mean the version we matched on may not be the version that
    // is running, so the match earns less of the confidence weight.
    if (input.backportRisk) confidence -= 0.4;
    if (input.versionConflict) confidence -= 0.4;
    beliefScore += WEIGHTS.confidence * clamp01(confidence);
  }

  const total = threatScore + beliefScore * freshnessMultiplier(input.evidenceAgeDays);

  return Math.round(total * 10) / 10;
};

/**
 * Whether a match may raise an interrupt-grade alert (email or push).
 *
 * Enforced here as well as at delivery so a matcher bug alone cannot page a
 * customer at 2am; the alerting rule re-checks the same predicate (PRD §9.3).
 * The conditions are conservative by design — everything excluded still shows
 * on the dashboard and in the weekly digest.
 */
export const isInterruptGrade = (input: {
  matchConfidence: ExposureMatchConfidence;
  severity: string | null;
  kevListed: boolean;
  backportRisk: boolean;
  versionConflict: boolean;
  verified: boolean;
  evidenceAgeDays: number;
  stalenessThresholdDays: number;
}): boolean => {
  // We never claim exposure from a version we could not read.
  if (input.matchConfidence !== 'exact_version') return false;

  // Evidence too old to stand behind: re-confirm the component first.
  if (input.evidenceAgeDays > input.stalenessThresholdDays) return false;

  // A backported fix or disagreeing observations mean the version string may
  // not reflect what is running. Verification settles it; nothing else does.
  if ((input.backportRisk || input.versionConflict) && !input.verified) return false;

  if (input.kevListed) return true;

  const severity = input.severity?.toLowerCase();
  return severity === 'critical' || severity === 'high';
};
