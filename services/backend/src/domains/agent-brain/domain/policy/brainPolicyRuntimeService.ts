import type { ToolAccessPolicy } from '../../domain/types';
import type { PolicyWithSpec } from './PolicyService';
import { type PolicyResolver } from './PolicyResolver';

export type BrainPolicySource = 'plan' | 'default' | 'explicit';

export interface ResolvedBrainPolicy {
  id: string;
  profile: string;
  sandboxProfile: string;
  toolPolicy?: ToolAccessPolicy;
  source: BrainPolicySource;
}

const hasPolicyShape = (policy?: unknown): policy is ToolAccessPolicy => {
  if (!policy || typeof policy !== 'object') {
    return false;
  }
  const candidate = policy as ToolAccessPolicy;
  return Boolean(
      (candidate.allow && candidate.allow.length > 0) ||
      (candidate.deny && candidate.deny.length > 0) ||
      (candidate.ask && candidate.ask.length > 0) ||
      (candidate.allowlist_hosts && candidate.allowlist_hosts.length > 0) ||
      (candidate.rules && candidate.rules.length > 0) ||
      candidate.network,
  );
};

export const mergeToolPolicies = (
  ...policies: Array<ToolAccessPolicy | undefined | null>
): ToolAccessPolicy | undefined => {
  const result: ToolAccessPolicy = {};

  for (const policy of policies) {
    if (!policy) {
      continue;
    }
    if (policy.allow && policy.allow.length > 0) {
      result.allow = mergeStringLists(result.allow, policy.allow);
    }
    if (policy.deny && policy.deny.length > 0) {
      result.deny = mergeStringLists(result.deny, policy.deny);
    }
    if (policy.ask && policy.ask.length > 0) {
      result.ask = mergeStringLists(result.ask, policy.ask);
    }
    if (policy.allowlist_hosts && policy.allowlist_hosts.length > 0) {
      result.allowlist_hosts = mergeStringLists(result.allowlist_hosts, policy.allowlist_hosts);
    }
    if (policy.rules && policy.rules.length > 0) {
      result.rules = [...(result.rules ?? []), ...policy.rules];
    }
    if (policy.network) {
      result.network = policy.network;
    }
  }

  return hasPolicyShape(result) ? result : undefined;
};

const mergeStringLists = (existing: string[] | undefined, incoming: string[]): string[] => {
  const set = new Set(existing ?? []);
  for (const value of incoming) {
    if (value && value.length > 0) {
      set.add(value);
    }
  }
  return Array.from(set);
};

class BrainPolicyRuntimeService {
  private readonly policyResolver?: PolicyResolver;

  constructor(policyResolver?: PolicyResolver) {
    this.policyResolver = policyResolver;
  }

  async resolvePolicy(
    args: { profile?: string | null; planSlug?: string | null } = {},
  ): Promise<ResolvedBrainPolicy | null> {
    const { profile } = args;
    const resolver = this.getResolver();

    const explicit =
      typeof profile === 'string' && profile.trim().length > 0
        ? await resolver.getBySlug(profile.trim())
        : null;
    if (explicit) {
      return this.toResolved(explicit, 'explicit');
    }

    const resolved = await resolver.resolvePolicy();
    return this.toResolved(resolved.policy, resolved.source === 'explicit' ? 'explicit' : 'default');
  }

  invalidateCache(): void {
    // no-op for now; could add caching layer later
  }

  private toResolved(policy: PolicyWithSpec, source: BrainPolicySource): ResolvedBrainPolicy {
    const specTools = isRecord(policy.spec) ? policy.spec.tools : undefined;
    const specToolPolicy = isRecord(policy.spec) ? policy.spec.toolPolicy : undefined;
    const toolPolicy =
      policy.parsedSpec.tools ?? policy.parsedSpec.toolPolicy ?? specTools ?? specToolPolicy;

    return {
      id: policy.id,
      profile: policy.slug,
      sandboxProfile: policy.slug,
      toolPolicy: hasPolicyShape(toolPolicy) ? toolPolicy : undefined,
      source,
    };
  }

  private getResolver(): PolicyResolver {
    const resolver = this.policyResolver;
    if (!resolver) {
      throw new Error('policy.resolver_uninitialized');
    }
    return resolver;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createBrainPolicyRuntimeService = (
  policyResolver?: PolicyResolver,
): BrainPolicyRuntimeService => {
  return new BrainPolicyRuntimeService(policyResolver);
};
