import type { ResolvedConfig } from '@/config/configTypes';
import { logger } from '@/shared/logger';
import { resolveCapabilityProfile, type ResolvedCapabilityProfile } from '../../adapters/sandbox';
import {
  createBrainPolicyRuntimeService,
  mergeToolPolicies,
  type ResolvedBrainPolicy,
} from '@/domains/agent-brain/domain/policy/brainPolicyRuntimeService';
import type { PolicyResolver } from '@/domains/agent-brain/domain/policy';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import type { PolicyTelemetry } from '@/shared/telemetry/PolicyTelemetry';
import type { SessionState, ToolAccessPolicy } from '../../domain/types';
import type { PolicyResolverPort } from '../../ports';

type BrainRuntime = ReturnType<typeof createBrainPolicyRuntimeService>;

/**
 * PolicyEngine centralizes policy concerns:
 * - Brain policy resolution (tool + sandbox profile selection)
 * - Sandbox capability lookup
 * - PolicyResolver instance (injected)
 */
export class PolicyEngine implements PolicyResolverPort {
  private readonly config?: ResolvedConfig;
  private readonly policyResolver: PolicyResolver;
  private readonly brainRuntime: BrainRuntime;
  private readonly telemetry?: PolicyTelemetry;

  constructor(config: ResolvedConfig | undefined, resolver: PolicyResolver, telemetry?: PolicyTelemetry) {
    this.config = config;
    this.policyResolver = resolver;
    this.brainRuntime = createBrainPolicyRuntimeService(this.policyResolver);
    this.telemetry = telemetry;
  }

  getResolver(): PolicyResolver {
    return this.policyResolver;
  }

  resetCache(): void {
    this.policyResolver.resetCache();
    this.brainRuntime.invalidateCache?.();
  }

  async resolveBrainPolicy(
    args: { profile?: string | null; planSlug?: string | null } = {},
  ): Promise<ResolvedBrainPolicy | null> {
    const result = await this.brainRuntime.resolvePolicy(args);
    if (result) {
      opsMetrics.recordPolicyResolution(result.source, result.profile);
      this.telemetry?.policyResolved(result.source, result.profile);
    }
    return result;
  }

  async resolve(session: SessionState, profileKey?: string): Promise<SessionState> {
    const planSlug = this.extractPlanSlug(session);
    const resolvedPolicy = await this.resolveBrainPolicy({
      planSlug,
      profile: profileKey,
    });

    const basePolicy = this.extractBaseToolPolicy(session);
    const mergedPolicy =
      mergeToolPolicies(basePolicy, resolvedPolicy?.toolPolicy) ??
      basePolicy ??
      resolvedPolicy?.toolPolicy ??
      undefined;

    if (mergedPolicy) {
      session.toolPolicy = mergedPolicy;
    } else {
      session.toolPolicy = undefined;
    }

    if (resolvedPolicy?.sandboxProfile) {
      session.sandboxProfile = resolvedPolicy.sandboxProfile;
    }

    session.flags = session.flags ?? {};
    if (resolvedPolicy) {
      session.flags.brain_policy = {
        profile: resolvedPolicy.profile,
        source: resolvedPolicy.source,
      };
    } else {
      delete session.flags.brain_policy;
    }

    return session;
  }

  async resolveSandboxCapabilities(profile?: string | null): Promise<ResolvedCapabilityProfile> {
    const resolved = await resolveCapabilityProfile(profile ?? undefined, this.config, this.policyResolver);
    if (!resolved) {
      logger.warn({ profile }, '[PolicyEngine] sandbox capability resolution returned empty result');
    }
    return resolved;
  }

  private extractPlanSlug(session: SessionState): string | undefined {
    const subscription = session.flags?.subscription as Record<string, unknown> | undefined;
    const planSlug = subscription?.planSlug ?? subscription?.plan_slug;
    return typeof planSlug === 'string' && planSlug.trim().length > 0
      ? planSlug.trim()
      : undefined;
  }

  private extractBaseToolPolicy(session: SessionState): ToolAccessPolicy | undefined {
    const base = session.flags?.policy_base as Record<string, unknown> | undefined;
    const candidate = base?.toolPolicy ?? base?.tool_policy;
    if (candidate && typeof candidate === 'object') {
      return candidate as ToolAccessPolicy;
    }
    return session.toolPolicy;
  }
}

export default PolicyEngine;

