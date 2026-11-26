import { createHash } from 'crypto';

import type { SessionFlags } from '@/domains/agent-brain/domain/types';
import { B1_ACCEPTED_CATALOG_VERSION } from '@/domains/agent-brain/domain/workers/enumerationContracts';

export const ENUMERATION_WORKER_CAPABILITY = 'enumeration_worker_v1';
export const ENUMERATION_WORKER_POLICY_VERSION = 1;

export type EnumerationWorkerCapabilityCohort =
  | 'disabled'
  | 'allowlist'
  | 'percentage';

export interface EnumerationWorkerCapabilitySnapshot {
  capability: typeof ENUMERATION_WORKER_CAPABILITY;
  enabled: boolean;
  cohort: EnumerationWorkerCapabilityCohort;
  policyVersion: 1;
  catalogVersion: typeof B1_ACCEPTED_CATALOG_VERSION;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const envEnabled = (value: string | undefined): boolean =>
  typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());

const parseOrgAllowlist = (value: string | undefined): Set<string> =>
  new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const parseRolloutPercent = (value: string | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.floor(parsed))) : 0;
};

export const stableEnumerationWorkerCohortBucket = (
  organizationId: string,
  policyVersion: number = ENUMERATION_WORKER_POLICY_VERSION,
): number =>
  Number.parseInt(
    createHash('sha256')
      .update(`${organizationId}|${policyVersion}`, 'utf8')
      .digest('hex')
      .slice(0, 8),
    16,
  ) % 100;

export const isEnumerationWorkerLiveEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => envEnabled(env.SECURITYOPS_ENUMERATION_WORKER_V1_ENABLED);

export const disabledEnumerationWorkerCapabilitySnapshot =
  (): EnumerationWorkerCapabilitySnapshot => ({
    capability: ENUMERATION_WORKER_CAPABILITY,
    enabled: false,
    cohort: 'disabled',
    policyVersion: ENUMERATION_WORKER_POLICY_VERSION,
    catalogVersion: B1_ACCEPTED_CATALOG_VERSION,
  });

export const resolveEnumerationWorkerCapabilitySnapshot = (params: {
  organizationId: string;
  env?: NodeJS.ProcessEnv;
}): EnumerationWorkerCapabilitySnapshot => {
  const env = params.env ?? process.env;
  if (!isEnumerationWorkerLiveEnabled(env)) {
    return disabledEnumerationWorkerCapabilitySnapshot();
  }
  if (parseOrgAllowlist(env.SECURITYOPS_ENUMERATION_WORKER_V1_ORG_IDS).has(params.organizationId)) {
    return {
      ...disabledEnumerationWorkerCapabilitySnapshot(),
      enabled: true,
      cohort: 'allowlist',
    };
  }
  const rolloutPercent = parseRolloutPercent(
    env.SECURITYOPS_ENUMERATION_WORKER_V1_ROLLOUT_PERCENT,
  );
  if (
    rolloutPercent > 0 &&
    stableEnumerationWorkerCohortBucket(params.organizationId) < rolloutPercent
  ) {
    return {
      ...disabledEnumerationWorkerCapabilitySnapshot(),
      enabled: true,
      cohort: 'percentage',
    };
  }
  return disabledEnumerationWorkerCapabilitySnapshot();
};

export const readEnumerationWorkerCapabilitySnapshot = (
  flags: SessionFlags | undefined,
): EnumerationWorkerCapabilitySnapshot | undefined => {
  const securityops = isRecord(flags?.securityops) ? flags.securityops : undefined;
  const value = isRecord(securityops?.enumerationWorkerV1)
    ? securityops.enumerationWorkerV1
    : undefined;
  if (
    value?.capability !== ENUMERATION_WORKER_CAPABILITY ||
    typeof value.enabled !== 'boolean' ||
    !['disabled', 'allowlist', 'percentage'].includes(String(value.cohort)) ||
    value.policyVersion !== ENUMERATION_WORKER_POLICY_VERSION ||
    value.catalogVersion !== B1_ACCEPTED_CATALOG_VERSION
  ) {
    return undefined;
  }
  return value as unknown as EnumerationWorkerCapabilitySnapshot;
};

export const getEnumerationWorkerAdmissionState = (
  flags: SessionFlags | undefined,
  env: NodeJS.ProcessEnv = process.env,
): {
  allowed: boolean;
  reason:
    | 'enabled'
    | 'snapshot_missing'
    | 'snapshot_disabled'
    | 'kill_switch_disabled';
  snapshot?: EnumerationWorkerCapabilitySnapshot;
} => {
  const snapshot = readEnumerationWorkerCapabilitySnapshot(flags);
  if (!snapshot) {
    return { allowed: false, reason: 'snapshot_missing' };
  }
  if (!snapshot.enabled) {
    return { allowed: false, reason: 'snapshot_disabled', snapshot };
  }
  if (!isEnumerationWorkerLiveEnabled(env)) {
    return { allowed: false, reason: 'kill_switch_disabled', snapshot };
  }
  return { allowed: true, reason: 'enabled', snapshot };
};
