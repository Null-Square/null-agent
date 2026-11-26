/**
 * What a customer states when they authorize a scope, and the one rule for
 * when they have to state it again.
 *
 * This lives in contracts because both sides need the same answer: the scope
 * page decides whether to put the statement in front of the customer, and the
 * API decides whether to accept the save. Two copies of "does this widen the
 * boundary?" would eventually disagree, and the disagreement would show up as a
 * save the UI thought was fine being refused by the server.
 *
 * Authorization is evidence, not a gate. Nothing here is consulted to decide
 * whether a run may start — target verification remains the only activation
 * state. If this module ever appears in a run prerequisite, that is the bug.
 */

export const SCOPE_AUTHORIZATION_STATEMENT_VERSION = 'scope-authorization-v1';

/**
 * Stored with every acceptance, not just referenced by version, so nobody has
 * to read old code to find out what a customer actually agreed to.
 */
export const SCOPE_AUTHORIZATION_STATEMENT =
  'I confirm that my organization owns the targets in this scope, or that I have authority from the owner to authorize security testing of them, and I authorize testing at the impact level shown.';

export type ScopeRuleType = 'domain' | 'cidr';

export interface ScopeRule {
  type: ScopeRuleType;
  value: string;
}

export type ScopeImpactTolerance = 'non_destructive' | 'poc' | 'full';

/**
 * The four things that actually change what the agent may do.
 *
 * Name, mission and compliance frameworks are excluded by construction: they
 * describe a scope, they do not widen it, and asking for a fresh warranty on a
 * rename is how a legal statement becomes a reflex click.
 */
export interface ScopeContract {
  roots: ScopeRule[];
  exclusions: ScopeRule[];
  impactTolerance: ScopeImpactTolerance;
  executionNetwork: string;
}

const IMPACT_RANK: Record<ScopeImpactTolerance, number> = {
  non_destructive: 0,
  poc: 1,
  full: 2,
};

const normalizeRule = (rule: ScopeRule): ScopeRule => ({
  type: rule.type,
  value: rule.value.trim().toLowerCase(),
});

const sortRules = (rules: ScopeRule[]): ScopeRule[] =>
  [...rules].sort(
    (left, right) => left.type.localeCompare(right.type) || left.value.localeCompare(right.value),
  );

/** Order- and case-independent, so a digest tracks the set rather than a query plan. */
export const normalizeContract = (contract: ScopeContract): ScopeContract => ({
  roots: sortRules(contract.roots.map(normalizeRule)),
  exclusions: sortRules(contract.exclusions.map(normalizeRule)),
  impactTolerance: contract.impactTolerance,
  executionNetwork: contract.executionNetwork,
});

/**
 * Does `candidate` cover `rule`?
 *
 * A domain covers itself and its descendants: authorizing `example.com` covers
 * `api.example.com`, so adding the subdomain later is not a widening. CIDRs are
 * compared literally — deciding whether one range contains another is
 * `ScopeBoundaryService`'s job, and duplicating that logic here would be a
 * second opinion on the same question.
 */
export const scopeRuleCovers = (candidate: ScopeRule, rule: ScopeRule): boolean => {
  if (candidate.type !== rule.type) return false;
  if (candidate.value === rule.value) return true;
  if (candidate.type !== 'domain') return false;
  return rule.value.endsWith(`.${candidate.value}`);
};

export type ScopeWideningReason =
  | 'root_added'
  | 'exclusion_removed'
  | 'impact_raised'
  | 'execution_network_changed';

/** One short sentence per reason, for the screen that asks. */
export const SCOPE_WIDENING_REASON_LABELS: Record<ScopeWideningReason, string> = {
  root_added: 'A new target is being brought into the boundary.',
  exclusion_removed: 'An exclusion is being removed, making a protected host reachable again.',
  impact_raised: 'The impact limit is being raised.',
  execution_network_changed: 'Tests will run from a different network.',
};

/**
 * Why the customer has to say it again.
 *
 * Only widening asks. Removing a target, adding an exclusion and lowering
 * impact all narrow what the agent may do, and a statement covering the broader
 * contract still covers the narrower one.
 */
export const findScopeWideningReasons = (
  authorized: ScopeContract | null,
  next: ScopeContract,
): ScopeWideningReason[] => {
  if (!authorized) return ['root_added'];

  const previous = normalizeContract(authorized);
  const current = normalizeContract(next);
  const reasons: ScopeWideningReason[] = [];

  if (current.roots.some((root) => !previous.roots.some((prior) => scopeRuleCovers(prior, root)))) {
    reasons.push('root_added');
  }
  if (
    previous.exclusions.some(
      (prior) => !current.exclusions.some((exclusion) => scopeRuleCovers(exclusion, prior)),
    )
  ) {
    reasons.push('exclusion_removed');
  }
  if (IMPACT_RANK[current.impactTolerance] > IMPACT_RANK[previous.impactTolerance]) {
    reasons.push('impact_raised');
  }
  if (current.executionNetwork !== previous.executionNetwork) {
    reasons.push('execution_network_changed');
  }
  return reasons;
};

export const scopeChangeRequiresStatement = (
  authorized: ScopeContract | null,
  next: ScopeContract,
): boolean => findScopeWideningReasons(authorized, next).length > 0;
