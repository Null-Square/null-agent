import {
  isIpv4CidrContainedIn,
  isIpv4InCidr,
  isValidIpv4Cidr,
  parseIpv4Address,
} from './networkTargetPolicy';

export type ScopeRuleType = 'domain' | 'cidr';

export interface ScopeNamespaceRule {
  type: ScopeRuleType;
  value: string;
}

export interface ScopeNamespaceDecision {
  allowed: boolean;
  reason: 'in_scope' | 'excluded' | 'no_matching_root' | 'invalid_target';
  normalizedType?: 'domain' | 'ip';
  normalizedValue?: string;
  matchedRoot?: ScopeNamespaceRule;
  matchedExclusion?: ScopeNamespaceRule;
}

const normalizeHostname = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
      return undefined;
    }
    return parsed.hostname.replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.$/u, '').toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

export const normalizeScopeRule = (rule: ScopeNamespaceRule): ScopeNamespaceRule | undefined => {
  if (rule.type === 'cidr') {
    const value = rule.value.trim().toLowerCase();
    return isValidIpv4Cidr(value) ? { type: 'cidr', value } : undefined;
  }
  const value = normalizeHostname(rule.value);
  if (!value || parseIpv4Address(value) !== null) {
    return undefined;
  }
  return { type: 'domain', value };
};

const domainContains = (container: string, candidate: string): boolean =>
  candidate === container || candidate.endsWith(`.${container}`);

export const scopeRuleContains = (
  containerRule: ScopeNamespaceRule,
  candidateRule: ScopeNamespaceRule,
): boolean => {
  const container = normalizeScopeRule(containerRule);
  const candidate = normalizeScopeRule(candidateRule);
  if (!container || !candidate || container.type !== candidate.type) {
    return false;
  }
  return container.type === 'domain'
    ? domainContains(container.value, candidate.value)
    : isIpv4CidrContainedIn(candidate.value, container.value);
};

export const decideScopeNamespace = (input: {
  kind: 'domain' | 'ip';
  value: string;
  roots: ScopeNamespaceRule[];
  exclusions?: ScopeNamespaceRule[];
}): ScopeNamespaceDecision => {
  const normalizedValue = input.kind === 'domain'
    ? normalizeHostname(input.value)
    : (() => {
        const host = normalizeHostname(input.value) ?? input.value.trim();
        return parseIpv4Address(host) !== null ? host : undefined;
      })();

  if (!normalizedValue) {
    return { allowed: false, reason: 'invalid_target' };
  }

  const normalizedRoots = input.roots
    .map(normalizeScopeRule)
    .filter((rule): rule is ScopeNamespaceRule => rule !== undefined);
  const normalizedExclusions = (input.exclusions ?? [])
    .map(normalizeScopeRule)
    .filter((rule): rule is ScopeNamespaceRule => rule !== undefined);

  const matchedExclusion = normalizedExclusions.find((rule) =>
    input.kind === 'domain'
      ? rule.type === 'domain' && domainContains(rule.value, normalizedValue)
      : rule.type === 'cidr' && isIpv4InCidr(normalizedValue, rule.value),
  );
  if (matchedExclusion) {
    return {
      allowed: false,
      reason: 'excluded',
      normalizedType: input.kind,
      normalizedValue,
      matchedExclusion,
    };
  }

  const matchedRoot = normalizedRoots.find((rule) =>
    input.kind === 'domain'
      ? rule.type === 'domain' && domainContains(rule.value, normalizedValue)
      : rule.type === 'cidr' && isIpv4InCidr(normalizedValue, rule.value),
  );
  return matchedRoot
    ? {
        allowed: true,
        reason: 'in_scope',
        normalizedType: input.kind,
        normalizedValue,
        matchedRoot,
      }
    : {
        allowed: false,
        reason: 'no_matching_root',
        normalizedType: input.kind,
        normalizedValue,
      };
};

export const decideScopeTargetRef = (input: {
  targetRef: string;
  roots: ScopeNamespaceRule[];
  exclusions?: ScopeNamespaceRule[];
}): ScopeNamespaceDecision => {
  const raw = input.targetRef.trim();
  const hostname = normalizeHostname(raw);
  if (!hostname) {
    return { allowed: false, reason: 'invalid_target' };
  }
  return decideScopeNamespace({
    kind: parseIpv4Address(hostname) !== null ? 'ip' : 'domain',
    value: hostname,
    roots: input.roots,
    exclusions: input.exclusions,
  });
};
