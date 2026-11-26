import type { CapacityProfileKey, RunSchedulingClass } from '@/db/schema';

export type SandboxResourceLimits = {
  memoryMb: number;
  cpuQuota: number;
  pidsLimit: number;
};

export type CloudRunSchedulingConfig = {
  /** Always false in Null AI: it runs for one person on one computer, so runs start directly. */
  queueCloudRuns: boolean;
  /** Optional stable override. By default the Docker host identity names the runner. */
  runnerName: string | null;
  claimTtlMs: number;
  heartbeatMaxAgeMs: number;
  planStarvationMs: number;
  backlogByClass: Record<RunSchedulingClass, number>;
  profiles: Record<CapacityProfileKey, {
    version: number;
    memoryMb: number;
    containerSlots: number;
    cpuMillis: number | null;
    pidLimit: number | null;
  }>;
};

const DEFAULT_SANDBOX_LIMITS: SandboxResourceLimits = {
  memoryMb: 1_024,
  cpuQuota: 1,
  pidsLimit: 256,
};

const positiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeLimits = (limits: Partial<SandboxResourceLimits> | undefined): SandboxResourceLimits => ({
  memoryMb: Number.isInteger(limits?.memoryMb) && Number(limits?.memoryMb) > 0
    ? Number(limits?.memoryMb)
    : DEFAULT_SANDBOX_LIMITS.memoryMb,
  cpuQuota: Number.isFinite(limits?.cpuQuota) && Number(limits?.cpuQuota) > 0
    ? Number(limits?.cpuQuota)
    : DEFAULT_SANDBOX_LIMITS.cpuQuota,
  pidsLimit: Number.isInteger(limits?.pidsLimit) && Number(limits?.pidsLimit) > 0
    ? Number(limits?.pidsLimit)
    : DEFAULT_SANDBOX_LIMITS.pidsLimit,
});

/**
 * Scheduling profiles are projections of the limits Docker actually enforces.
 * They are not a second capacity configuration surface.
 */
export const loadCloudRunSchedulingConfig = (
  env: NodeJS.ProcessEnv = process.env,
  sandboxLimits?: Partial<SandboxResourceLimits>,
): CloudRunSchedulingConfig => {
  const limits = normalizeLimits(sandboxLimits);
  const cpuMillis = Math.max(1, Math.ceil(limits.cpuQuota * 1_000));
  return {
    queueCloudRuns: false,
    runnerName: env.CLOUD_RUNNER_NAME?.trim() || null,
    claimTtlMs: positiveInteger(env.CLOUD_RUN_CLAIM_TTL_MS, 60_000),
    heartbeatMaxAgeMs: positiveInteger(env.CLOUD_RUN_HEARTBEAT_MAX_AGE_MS, 90_000),
    planStarvationMs: positiveInteger(
      env.CLOUD_RUN_PLAN_STARVATION_MS ?? env.CLOUD_RUN_FREE_STARVATION_MS,
      15 * 60_000,
    ),
    backlogByClass: {
      free: positiveInteger(env.CLOUD_RUN_FREE_BACKLOG, 1),
      paid: positiveInteger(env.CLOUD_RUN_PAID_BACKLOG, 3),
      pro: positiveInteger(env.CLOUD_RUN_PRO_BACKLOG, 5),
      internal: positiveInteger(env.CLOUD_RUN_INTERNAL_BACKLOG, 10),
    },
    profiles: {
      control: {
        version: 2,
        memoryMb: 0,
        containerSlots: 0,
        cpuMillis: null,
        pidLimit: null,
      },
      standard: {
        version: 2,
        memoryMb: limits.memoryMb,
        containerSlots: 1,
        cpuMillis,
        pidLimit: limits.pidsLimit,
      },
      // Every admitted execution Run can make progress with its shared primary
      // container plus one worker. Optional workers acquire standard leases.
      heavy: {
        version: 2,
        memoryMb: limits.memoryMb * 2,
        containerSlots: 2,
        cpuMillis: cpuMillis * 2,
        pidLimit: limits.pidsLimit * 2,
      },
    },
  };
};

export const schedulingClassForPlan = (planSlug: string | null | undefined): RunSchedulingClass => {
  const normalized = planSlug?.trim().toLowerCase();
  if (normalized === 'internal') return 'internal';
  if (normalized === 'customize') return 'pro';
  if (normalized === 'control') return 'paid';
  return 'free';
};
