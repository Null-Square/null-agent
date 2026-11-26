import type { ResolvedConfig } from '@/config/configTypes';
import type { NetworkMode } from './types';
import { type PolicyResolver } from '../../domain/policy';
import { logger } from '@/shared/logger';

const isVerbose = (config?: ResolvedConfig): boolean =>
  config?.policy?.verboseLogging === true ||
  ['1', 'true', 'yes', 'on'].includes(
    String(process.env.LOG_INCLUDE_DOCKER ?? process.env.LOG_VERBOSE_SANDBOX ?? '').toLowerCase(),
  );

export type ResolvedCapabilityProfile = {
  name: string;
  privileged: boolean;
  readonlyRootfs: boolean;
  network: NetworkMode;
  capDrop: string[];
  capAdd: string[];
  seccomp?: string | null;
  user?: string;
};

const normalizeCaps = (values: string[] | undefined): string[] =>
  (values ?? [])
    .map((value) => value?.toString().trim())
    .filter((value): value is string => Boolean(value && value.length > 0));

export async function resolveCapabilityProfile(
  taskProfile: string | undefined,
  config: ResolvedConfig | undefined,
  policyResolver: PolicyResolver,
): Promise<ResolvedCapabilityProfile> {
  const requestedProfileName = taskProfile;
  const verboseSandboxLogging = isVerbose(config);
  if (verboseSandboxLogging) {
    logger.debug({ requestedProfileName }, '[policy] resolving sandbox policy');
  } else {
    logger.trace?.({ requestedProfileName }, '[policy] resolving sandbox policy');
  }
  const defaultPolicy = await policyResolver.getDefaultPolicy();
  let policy = requestedProfileName ? await policyResolver.getBySlug(requestedProfileName) : defaultPolicy;

  if (!policy) {
    const resolved = await policyResolver.resolvePolicy();
    policy = resolved.policy;
  }

  if (!policy && requestedProfileName) {
    // If an explicit policy was requested but not found, fall back to default if present; otherwise error.
    policy = defaultPolicy;
    if (!policy) {
      throw new Error(
        `policy.sandbox.not_found: ${requestedProfileName} (no default sandbox policy configured)`,
      );
    }
  }

  if (!policy) {
    throw new Error('policy.sandbox.not_found: no default sandbox policy configured');
  }

  const policyLogPayload = {
    requestedProfileName,
    resolvedPolicy: policy.slug,
    defaultPolicy: defaultPolicy?.slug,
  };
  if (verboseSandboxLogging) {
    logger.debug(policyLogPayload, '[policy] sandbox policy selected');
  } else {
    logger.trace?.(policyLogPayload, '[policy] sandbox policy selected');
  }

  const sandboxSpec = policy.parsedSpec.sandbox ?? {};

  const privileged = Boolean(sandboxSpec.privileged);
  if (privileged) {
    const env = process.env.NODE_ENV ?? 'development';
    const allowedEnv = env !== 'production' && env !== 'staging' && env !== 'stage';
    const allowedUnsafe = config?.sandbox.devUnsafe === true;
    if (!allowedEnv || !allowedUnsafe) {
      logger.warn(
        { profile: policy.slug, env, devUnsafe: allowedUnsafe },
        '[policy] Privileged profile requested but dev_unsafe is off; rejecting',
      );
      throw new Error('policy.capabilities.privileged_requires_dev_unsafe');
    }
  }

  const capAdd = normalizeCaps(sandboxSpec.capAdd);
  const capDrop =
    privileged && capAdd.length === 0
      ? []
      : normalizeCaps(sandboxSpec.capDrop).length > 0
        ? normalizeCaps(sandboxSpec.capDrop)
        : ['ALL'];

  const configuredNetwork = config?.sandbox.network?.trim();
  const fallbackNetwork: NetworkMode = configuredNetwork && configuredNetwork.length > 0
    ? configuredNetwork
    : 'bridge';

  return {
    name: policy.slug,
    privileged,
    readonlyRootfs: sandboxSpec.readonlyRootfs ?? true,
    // Which network a sandbox joins is the deployment's to say (SANDBOX_NETWORK: the sealed
    // network under compose). A policy may only turn networking off.
    network: sandboxSpec.network === 'none' ? 'none' : fallbackNetwork,
    capDrop,
    capAdd: privileged ? [] : capAdd,
    seccomp: sandboxSpec.seccompProfilePath ?? null,
    user: sandboxSpec.user,
  };
}

