import { parse as parseDomain } from 'tldts';

export interface ScopeTargetBoundaryInput {
  type: string;
  value: string;
}

export interface ScopeDomainBoundaryTarget {
  type: 'domain';
  value: string;
  boundary: string;
}

export interface ScopeDomainBoundaryConflict {
  expected: ScopeDomainBoundaryTarget;
  received: ScopeDomainBoundaryTarget;
}

const SHARED_HOSTED_SITE_PARENT_DOMAINS = [
  'myshopify.com',
  'squarespace.com',
  'webflow.io',
  'wixsite.com',
  'wordpress.com',
  'wpcomstaging.com',
  'wpengine.com',
  'flywheelsites.com',
] as const;

const normalizeDomainBoundaryInput = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/u, '');

const resolveSharedHostedSiteBoundary = (normalizedDomain: string): string | null => {
  for (const parentDomain of SHARED_HOSTED_SITE_PARENT_DOMAINS) {
    if (normalizedDomain === parentDomain) {
      return parentDomain;
    }

    const suffix = `.${parentDomain}`;
    if (!normalizedDomain.endsWith(suffix)) {
      continue;
    }

    const tenantLabels = normalizedDomain
      .slice(0, -suffix.length)
      .split('.')
      .filter(Boolean);
    const tenantLabel = tenantLabels.at(-1);
    return tenantLabel ? `${tenantLabel}.${parentDomain}` : parentDomain;
  }

  return null;
};

export const resolveDomainScopeBoundary = (value: string): string => {
  const normalizedDomain = normalizeDomainBoundaryInput(value);
  const sharedHostedBoundary = resolveSharedHostedSiteBoundary(normalizedDomain);
  if (sharedHostedBoundary) {
    return sharedHostedBoundary;
  }

  const parsed = parseDomain(normalizedDomain, { allowPrivateDomains: true });
  return parsed.domain ?? normalizedDomain;
};

export const isStrictSubdomainOfTarget = (candidate: string, parent: string): boolean => {
  const normalizedCandidate = normalizeDomainBoundaryInput(candidate);
  const normalizedParent = normalizeDomainBoundaryInput(parent);
  return (
    normalizedCandidate.length > normalizedParent.length &&
    normalizedCandidate.endsWith(`.${normalizedParent}`)
  );
};

export const findScopeDomainBoundaryConflict = (
  targets: readonly ScopeTargetBoundaryInput[],
): ScopeDomainBoundaryConflict | null => {
  let expected: ScopeDomainBoundaryTarget | null = null;

  for (const target of targets) {
    if (target.type !== 'domain') {
      continue;
    }

    const candidate: ScopeDomainBoundaryTarget = {
      type: 'domain',
      value: normalizeDomainBoundaryInput(target.value),
      boundary: resolveDomainScopeBoundary(target.value),
    };

    if (!expected) {
      expected = candidate;
      continue;
    }

    if (candidate.boundary !== expected.boundary) {
      return { expected, received: candidate };
    }
  }

  return null;
};

export const buildScopeDomainBoundaryConflictMessage = (
  conflict: ScopeDomainBoundaryConflict,
): string =>
  `A scope can only contain one domain boundary (${conflict.expected.boundary}). ` +
  `Create a separate scope for ${conflict.received.value}.`;
