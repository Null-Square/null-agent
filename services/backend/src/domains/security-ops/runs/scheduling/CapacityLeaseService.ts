import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  capacityLeases,
  runEvents,
  runners,
  runs,
  type CapacityLeasePurpose,
  type CapacityLeaseRow,
  type RunnerRow,
  type RunnerSchedulingMode,
} from '@/db/schema';
import { AppError, ERROR_CODES } from '@/shared/errors';
import { PLAN_CONCURRENT_RUN_STATUSES } from '../RunLifecycleHelpers';
import type { CapacityProfile } from './CapacityProfileRegistry';
import type { CloudRunSchedulingConfig } from './CloudRunSchedulingConfig';
import { OPERATOR_MODE_METADATA_KEY } from './CloudCapacityOperationsService';
import {
  AutomaticHostCapacityProbe,
  type AutomaticHostCapacitySample,
} from './AutomaticHostCapacity';

const LIVE_LEASE_STATES = ['held', 'active', 'releasing'] as const;
const PENDING_FINGERPRINT_METADATA_KEY = 'cloudSchedulingPendingFingerprint';
const STALE_FINGERPRINTS_METADATA_KEY = 'cloudSchedulingStaleFingerprints';

const staleFingerprintKeys = (value: string | undefined): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string').slice(-8) : [];
  } catch {
    return [];
  }
};

const locallyHeldRunner = (runner: RunnerRow, reason: string): RunnerRow => ({
  ...runner,
  status: 'quarantined',
  schedulingMode: 'hold',
  schedulingReason: reason,
});

export type CapacityAdmissionResult =
  | {
      admitted: true;
      run: typeof runs.$inferSelect;
      runner: RunnerRow;
      lease: CapacityLeaseRow;
    }
  | { admitted: false; permanent: boolean; reason: string };

export type WorkerCapacityAdmissionResult =
  { admitted: true; leaseId: string | null; includedInBundle: boolean } | { admitted: false; reason: string };

const snapshotNumber = (snapshot: Record<string, unknown> | null, key: string): number | null => {
  const value = snapshot?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export class CapacityLeaseService {
  private readonly readHostCapacity: () => Promise<AutomaticHostCapacitySample>;
  private localHostFingerprint: string | null = null;
  private localRunnerName: string | null = null;

  constructor(
    private readonly db: DatabaseClient,
    private readonly config: CloudRunSchedulingConfig,
    private readonly now: () => Date = () => new Date(),
    readHostCapacity?: () => AutomaticHostCapacitySample | Promise<AutomaticHostCapacitySample>,
  ) {
    const probe = new AutomaticHostCapacityProbe(config);
    this.readHostCapacity = readHostCapacity
      ? async () => readHostCapacity()
      : async () => probe.sample();
  }

  async ensurePlatformCloudRunner(): Promise<RunnerRow> {
    const health = await this.readHostCapacity();
    this.localHostFingerprint = health.reliable ? health.hostFingerprint : null;
    const runnerName = this.config.runnerName
      ?? (health.hostIdentity ? `null-ai-cloud-${health.hostIdentity}` : null);
    if (!runnerName) throw new Error(health.failureReason ?? 'automatic_runner_identity_unavailable');
    this.localRunnerName = runnerName;
    const now = this.now();
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform-runner:${runnerName}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(runners)
        .where(and(eq(runners.ownership, 'platform'), eq(runners.name, runnerName)))
        .limit(1)
        .for('update');
      if (existing) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity-runner:${existing.id}`}, 0))`);
      }
      const metadata = { ...(existing?.metadata ?? {}) };
      const reportedFingerprint = health.reliable ? health.hostFingerprint : null;
      const storedFingerprint = existing?.hostFingerprint ?? null;
      const pendingFingerprint = metadata[PENDING_FINGERPRINT_METADATA_KEY];
      const staleFingerprints = staleFingerprintKeys(metadata[STALE_FINGERPRINTS_METADATA_KEY]);
      if (
        existing
        && reportedFingerprint
        && reportedFingerprint !== storedFingerprint
        && staleFingerprints.includes(reportedFingerprint)
      ) {
        return locallyHeldRunner(existing, 'stale_deployment_fingerprint');
      }
      if (existing && pendingFingerprint && reportedFingerprint === storedFingerprint) {
        return locallyHeldRunner(existing, 'fingerprint_change_pending');
      }
      if (
        existing
        && pendingFingerprint
        && reportedFingerprint
        && reportedFingerprint !== storedFingerprint
        && reportedFingerprint !== pendingFingerprint
      ) {
        return locallyHeldRunner(existing, 'fingerprint_change_conflict');
      }

      let applyReportedFingerprint = false;
      let fingerprintChangePending = false;
      if (existing && reportedFingerprint && reportedFingerprint !== storedFingerprint) {
        const [liveUsage] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(capacityLeases)
          .where(
            and(eq(capacityLeases.runnerId, existing.id), inArray(capacityLeases.state, [...LIVE_LEASE_STATES])),
          );
        const leaseFree = Number(liveUsage?.count ?? 0) === 0;
        if (leaseFree) {
          applyReportedFingerprint = true;
          if (storedFingerprint) {
            metadata[STALE_FINGERPRINTS_METADATA_KEY] = JSON.stringify(
              [...staleFingerprints.filter((key) => key !== storedFingerprint), storedFingerprint].slice(-8),
            );
          }
          delete metadata[PENDING_FINGERPRINT_METADATA_KEY];
        } else {
          fingerprintChangePending = true;
          metadata[PENDING_FINGERPRINT_METADATA_KEY] = reportedFingerprint;
        }
      }

      const fingerprintReady = health.reliable && !fingerprintChangePending;
      const useDetectedCapacity = fingerprintReady && (!existing || storedFingerprint === reportedFingerprint || applyReportedFingerprint);
      const hostFingerprint = useDetectedCapacity ? reportedFingerprint : storedFingerprint;
      const detectedMemoryMb = useDetectedCapacity && health.allocatableMemoryMb > 0
        ? health.allocatableMemoryMb
        : existing?.detectedMemoryMb ?? null;
      const detectedContainerSlots = useDetectedCapacity && health.detectedContainerSlots > 0
        ? health.detectedContainerSlots
        : existing?.detectedContainerSlots ?? null;
      const derivedActiveRunLimit = useDetectedCapacity && health.derivedActiveRunLimit > 0
        ? health.derivedActiveRunLimit
        : existing?.derivedActiveRunLimit ?? null;
      const capacitySufficient = Boolean(
        detectedMemoryMb
        && detectedContainerSlots
        && derivedActiveRunLimit
        && detectedMemoryMb >= this.config.profiles.heavy.memoryMb
        && detectedContainerSlots >= this.config.profiles.heavy.containerSlots,
      );
      const [liveUsage] = existing
        ? await tx
          .select({
            memoryMb: sql<number>`COALESCE(sum(${capacityLeases.memoryMb}), 0)::int`,
            containerSlots: sql<number>`COALESCE(sum(${capacityLeases.containerSlots}), 0)::int`,
            activeRuns: sql<number>`count(DISTINCT (${capacityLeases.runId}, ${capacityLeases.admissionEpoch}))::int`,
          })
          .from(capacityLeases)
          .where(and(eq(capacityLeases.runnerId, existing.id), inArray(capacityLeases.state, [...LIVE_LEASE_STATES])))
        : [{ memoryMb: 0, containerSlots: 0, activeRuns: 0 }];
      const leasedMemoryMb = Number(liveUsage?.memoryMb ?? 0);
      const liveHeadroomMb = Math.max(0, health.availableMemoryMb - health.emergencyReserveMemoryMb);
      const admissionMemoryMb = detectedMemoryMb === null
        ? 0
        : Math.min(detectedMemoryMb, leasedMemoryMb + liveHeadroomMb);
      const pressured = health.memoryPressured || health.cpuPressured || health.diskPressured;
      const rawOperatorMode = existing?.metadata?.[OPERATOR_MODE_METADATA_KEY];
      const operatorMode: RunnerSchedulingMode | null =
        rawOperatorMode === 'hold' || rawOperatorMode === 'draining' ? rawOperatorMode : null;
      const schedulingMode: RunnerSchedulingMode = operatorMode
        ?? (health.reliable && fingerprintReady && capacitySufficient && !pressured
          ? ('accepting' as const)
          : ('hold' as const));
      const schedulingReason = operatorMode === 'hold'
        ? 'operator_hold'
        : operatorMode === 'draining'
          ? 'operator_draining'
          : !health.reliable
            ? health.failureReason ?? 'automatic_capacity_unavailable'
            : fingerprintChangePending
              ? 'fingerprint_change_pending'
              : !capacitySufficient
                ? 'insufficient_detected_capacity'
          : health.memoryPressured
            ? 'host_memory_pressure'
            : health.cpuPressured
              ? 'host_cpu_pressure'
              : health.diskPressured
                ? 'host_disk_pressure'
              : null;
      const values = {
        organizationId: null,
        name: runnerName,
        type: 'cloud',
        ownership: 'platform' as const,
        status: !health.reliable || !fingerprintReady || !capacitySufficient
          ? 'quarantined'
          : pressured
            ? 'busy'
            : 'online',
        schedulingMode,
        platform: 'docker',
        hostFingerprint,
        capacityPolicyVersion: 3,
        detectedMemoryMb,
        detectedContainerSlots,
        derivedActiveRunLimit,
        capacitySource: health.source,
        schedulingReason,
        lastHeartbeatAt: now,
        heartbeatSequence: sql`${runners.heartbeatSequence} + 1`,
        healthSnapshot: {
          source: 'scheduler_worker',
          capacitySource: health.source,
          reliable: health.reliable,
          failureReason: health.failureReason,
          pressured,
          memoryPressured: health.memoryPressured,
          cpuPressured: health.cpuPressured,
          diskPressured: health.diskPressured,
          totalMemoryMb: health.totalMemoryMb,
          availableMemoryMb: health.availableMemoryMb,
          backendMemoryLimitMb: health.backendMemoryLimitMb,
          platformReserveMemoryMb: health.platformReserveMemoryMb,
          emergencyReserveMemoryMb: health.emergencyReserveMemoryMb,
          allocatableMemoryMb: health.allocatableMemoryMb,
          platformReserveCpuMillis: health.platformReserveCpuMillis,
          allocatableCpuMillis: health.allocatableCpuMillis,
          admissionMemoryMb,
          leasedMemoryMb,
          leasedContainerSlots: Number(liveUsage?.containerSlots ?? 0),
          leasedActiveRuns: Number(liveUsage?.activeRuns ?? 0),
          load1m: health.load1m,
          loadPerCpu: health.loadPerCpu,
          cpuCount: health.cpuCount,
          workspaceTotalMb: health.workspaceTotalMb,
          workspaceAvailableMb: health.workspaceAvailableMb,
          workspaceReserveMb: health.workspaceReserveMb,
          reportedFingerprint,
          reportedFingerprintApplied: applyReportedFingerprint,
          automaticAdmission: this.config.queueCloudRuns,
          operatorMode,
        },
        metadata,
        updatedAt: now,
      };
      if (existing) {
        const [updated] = await tx.update(runners).set(values).where(eq(runners.id, existing.id)).returning();
        if (!updated) throw new Error('Failed to update platform cloud runner');
        return updated;
      }
      const [created] = await tx
        .insert(runners)
        .values({
          ...values,
          heartbeatSequence: 1,
          createdAt: now,
        })
        .returning();
      if (!created) throw new Error('Failed to register platform cloud runner');
      return created;
    });
  }

  async acquireForClaim(params: {
    runId: string;
    claimOwner: string;
    profile: CapacityProfile;
    purpose: CapacityLeasePurpose;
    bundleKey: string;
    maxConcurrentRuns: number | null;
  }): Promise<CapacityAdmissionResult> {
    const initial = await this.db
      .select({ organizationId: runs.organizationId, scopeId: runs.scopeId })
      .from(runs)
      .where(eq(runs.id, params.runId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!initial) {
      return { admitted: false, permanent: true, reason: 'run_not_found' };
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-admit:org:${initial.organizationId}`}, 0))`,
      );
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-admit:scope:${initial.scopeId}`}, 0))`);
      const [run] = await tx.select().from(runs).where(eq(runs.id, params.runId)).limit(1).for('update');
      if (!run) return { admitted: false, permanent: true, reason: 'run_not_found' };
      if (run.status !== 'queued') {
        return {
          admitted: false,
          permanent: true,
          reason: `run_not_queued:${run.status}`,
        };
      }
      if (run.claimOwner !== params.claimOwner || !run.claimExpiresAt || run.claimExpiresAt <= this.now()) {
        return { admitted: false, permanent: false, reason: 'claim_lost' };
      }
      if (run.admittedAt) {
        return {
          admitted: false,
          permanent: false,
          reason: 'already_admitted',
        };
      }

      const [oldEpochLease] = await tx
        .select({ id: capacityLeases.id })
        .from(capacityLeases)
        .where(
          and(
            eq(capacityLeases.runId, run.id),
            ne(capacityLeases.admissionEpoch, run.admissionEpoch),
            inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
          ),
        )
        .limit(1);
      if (oldEpochLease) {
        return {
          admitted: false,
          permanent: false,
          reason: 'previous_epoch_releasing',
        };
      }

      if (params.maxConcurrentRuns !== null) {
        const [planRow] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, run.organizationId),
              ne(runs.id, run.id),
              or(
                inArray(runs.status, PLAN_CONCURRENT_RUN_STATUSES),
                and(eq(runs.status, 'queued'), sql`${runs.admittedAt} IS NOT NULL`),
              ),
            ),
          );
        if (Number(planRow?.count ?? 0) >= params.maxConcurrentRuns) {
          return {
            admitted: false,
            permanent: false,
            reason: 'waiting_for_plan_slot',
          };
        }
      }

      if (!this.localRunnerName) {
        return { admitted: false, permanent: false, reason: 'local_runner_identity_unavailable' };
      }
      const candidates = await tx
        .select()
        .from(runners)
        // This process can only create runtime on its own host. Other worker
        // hosts run the same queue loop and compete for claims independently;
        // selecting their row here would record false placement and launch the
        // container on the wrong machine.
        .where(
          and(eq(runners.ownership, 'platform'), eq(runners.type, 'cloud'), eq(runners.name, this.localRunnerName)),
        )
        .orderBy(asc(runners.createdAt));
      if (candidates.length === 0) {
        return {
          admitted: false,
          permanent: false,
          reason: 'no_platform_runner',
        };
      }

      let fitsAnyDetectedRunner = false;
      let lastReason = 'waiting_for_capacity';
      for (const candidateRef of candidates) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity-runner:${candidateRef.id}`}, 0))`);
        // Heartbeats and operator controls use the same runner lock. Re-read
        // after acquiring it so a concurrent hold/pressure transition cannot
        // be bypassed through the stale candidate snapshot above.
        const [candidate] = await tx.select().from(runners).where(eq(runners.id, candidateRef.id)).limit(1);
        if (!candidate) continue;
        const detectedMemoryLimit = candidate.detectedMemoryMb ?? 0;
        const admissionMemoryLimit = snapshotNumber(candidate.healthSnapshot, 'admissionMemoryMb') ?? 0;
        const memoryLimit = Math.min(detectedMemoryLimit, admissionMemoryLimit);
        const slotLimit = candidate.detectedContainerSlots ?? 0;
        if (
          params.profile.memoryMb <= detectedMemoryLimit
          && params.profile.containerSlots <= slotLimit
        ) {
          fitsAnyDetectedRunner = true;
        }
        if (candidate.schedulingMode !== 'accepting') {
          lastReason = candidate.schedulingReason || 'runner_held';
          continue;
        }
        if (candidate.status !== 'online') {
          lastReason = candidate.status === 'busy' ? 'runner_pressured' : `runner_${candidate.status}`;
          continue;
        }
        if (
          !candidate.lastHeartbeatAt ||
          this.now().getTime() - candidate.lastHeartbeatAt.getTime() > this.config.heartbeatMaxAgeMs
        ) {
          lastReason = 'runner_heartbeat_stale';
          continue;
        }
        if (!this.localHostFingerprint || candidate.hostFingerprint !== this.localHostFingerprint) {
          lastReason = 'runner_fingerprint_mismatch';
          continue;
        }
        if (params.profile.memoryMb > detectedMemoryLimit || params.profile.containerSlots > slotLimit) {
          lastReason = 'profile_exceeds_runner_capacity';
          continue;
        }
        if (params.profile.memoryMb > memoryLimit) {
          lastReason = 'waiting_for_capacity';
          continue;
        }
        const [usage] = await tx
          .select({
            memoryMb: sql<number>`COALESCE(sum(${capacityLeases.memoryMb}), 0)::int`,
            containerSlots: sql<number>`COALESCE(sum(${capacityLeases.containerSlots}), 0)::int`,
            activeRuns: sql<number>`count(DISTINCT (${capacityLeases.runId}, ${capacityLeases.admissionEpoch}))::int`,
          })
          .from(capacityLeases)
          .where(and(eq(capacityLeases.runnerId, candidate.id), inArray(capacityLeases.state, [...LIVE_LEASE_STATES])));
        if (
          Number(usage?.memoryMb ?? 0) + params.profile.memoryMb > memoryLimit ||
          Number(usage?.containerSlots ?? 0) + params.profile.containerSlots > slotLimit
        ) {
          lastReason = 'waiting_for_capacity';
          continue;
        }

        const now = this.now();
        const [lease] = await tx
          .insert(capacityLeases)
          .values({
            runnerId: candidate.id,
            runId: run.id,
            admissionEpoch: run.admissionEpoch,
            bundleKey: params.bundleKey,
            purpose: params.purpose,
            profileKey: params.profile.key,
            profileVersion: params.profile.version,
            memoryMb: params.profile.memoryMb,
            containerSlots: params.profile.containerSlots,
            cpuMillis: params.profile.cpuMillis,
            pidLimit: params.profile.pidLimit,
            state: 'held',
            reason: 'admission',
            acquiredAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!lease) throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to acquire capacity lease');
        const [updatedRun] = await tx
          .update(runs)
          .set({
            runnerId: candidate.id,
            capacityProfile: params.profile.key,
            capacityProfileVersion: params.profile.version,
            admittedAt: now,
            capacityWaitReason: null,
            admissionLastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(runs.id, run.id),
              eq(runs.admissionEpoch, run.admissionEpoch),
              eq(runs.claimOwner, params.claimOwner),
            ),
          )
          .returning();
        if (!updatedRun) throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Run admission claim changed');
        await tx.insert(runEvents).values({
          runId: run.id,
          type: 'run.admitted',
          note: `runner=${candidate.id};lease=${lease.id};epoch=${run.admissionEpoch}`,
        });
        return { admitted: true, run: updatedRun, runner: candidate, lease };
      }

      return {
        admitted: false,
        permanent: !fitsAnyDetectedRunner,
        reason: fitsAnyDetectedRunner ? lastReason : 'profile_exceeds_detected_capacity',
      };
    });
  }

  async activateLease(params: {
    leaseId: string;
    sessionId?: string | null;
    runtimeIdentities?: string[];
  }): Promise<void> {
    const now = this.now();
    const [activated] = await this.db
      .update(capacityLeases)
      .set({
        state: 'active',
        sessionId: params.sessionId ?? null,
        runtimeIdentities: params.runtimeIdentities ?? [],
        activatedAt: now,
        updatedAt: now,
      })
      .where(and(eq(capacityLeases.id, params.leaseId), eq(capacityLeases.state, 'held')))
      .returning({ id: capacityLeases.id });
    if (!activated) {
      throw new AppError(ERROR_CODES.VALIDATION_CONSTRAINT_VIOLATED, 'Capacity lease was not held at activation.');
    }
  }

  async getRuntimeOwnership(
    runId: string,
    admissionEpoch: number,
  ): Promise<{
    leaseId: string;
    bundleKey: string;
  } | null> {
    const [lease] = await this.db
      .select({ id: capacityLeases.id, bundleKey: capacityLeases.bundleKey })
      .from(capacityLeases)
      .where(
        and(
          eq(capacityLeases.runId, runId),
          eq(capacityLeases.admissionEpoch, admissionEpoch),
          sql`${capacityLeases.parentLeaseId} IS NULL`,
          inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
        ),
      )
      .orderBy(asc(capacityLeases.acquiredAt))
      .limit(1);
    return lease ? { leaseId: lease.id, bundleKey: lease.bundleKey } : null;
  }

  async verifyLocalRecoveryOwnership(
    runId: string,
    admissionEpoch: number,
  ): Promise<'owned' | 'missing' | 'wrong_host' | 'runner_unavailable'> {
    const [row] = await this.db
      .select({
        leaseRunnerId: capacityLeases.runnerId,
        runRunnerId: runs.runnerId,
        runnerName: runners.name,
        runnerFingerprint: runners.hostFingerprint,
        runnerStatus: runners.status,
        runnerHeartbeatAt: runners.lastHeartbeatAt,
      })
      .from(capacityLeases)
      .innerJoin(runs, eq(runs.id, capacityLeases.runId))
      .innerJoin(runners, eq(runners.id, capacityLeases.runnerId))
      .where(and(
        eq(capacityLeases.runId, runId),
        eq(capacityLeases.admissionEpoch, admissionEpoch),
        eq(capacityLeases.state, 'active'),
        sql`${capacityLeases.parentLeaseId} IS NULL`,
      ))
      .limit(1);
    if (!row || !row.runRunnerId || row.runRunnerId !== row.leaseRunnerId) return 'missing';
    if (
      !this.localRunnerName ||
      !this.localHostFingerprint ||
      row.runnerName !== this.localRunnerName ||
      row.runnerFingerprint !== this.localHostFingerprint
    ) {
      return 'wrong_host';
    }
    if (
      row.runnerStatus !== 'online' ||
      !row.runnerHeartbeatAt ||
      this.now().getTime() - row.runnerHeartbeatAt.getTime() > this.config.heartbeatMaxAgeMs
    ) {
      return 'runner_unavailable';
    }
    return 'owned';
  }

  async acquireWorkerCapacity(params: { runId: string; workerTaskId: string }): Promise<WorkerCapacityAdmissionResult> {
    if (!this.config.queueCloudRuns) {
      return { admitted: true, leaseId: null, includedInBundle: true };
    }
    const initial = await this.db
      .select({
        runnerId: runs.runnerId,
        admissionEpoch: runs.admissionEpoch,
        executionTarget: runs.executionTarget,
        status: runs.status,
      })
      .from(runs)
      .where(eq(runs.id, params.runId))
      .limit(1)
      .then((rows) => rows[0]);
    if (!initial) return { admitted: false, reason: 'run_not_found' };
    if (initial.executionTarget !== 'cloud') {
      return { admitted: true, leaseId: null, includedInBundle: true };
    }
    // Let Runs already active before scheduler migration finish. Every newly
    // queued production Run has a positive epoch and cannot use this bypass.
    if (initial.admissionEpoch <= 0) {
      return { admitted: true, leaseId: null, includedInBundle: true };
    }
    if (!initial.runnerId) return { admitted: false, reason: 'run_capacity_runner_missing' };
    if (initial.status !== 'running') return { admitted: false, reason: 'run_not_active' };

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity-runner:${initial.runnerId}`}, 0))`,
      );
      const [run] = await tx.select().from(runs).where(eq(runs.id, params.runId)).limit(1).for('update');
      if (!run?.runnerId || run.status !== 'running') {
        return { admitted: false, reason: 'run_not_active' };
      }
      const [runner] = await tx
        .select()
        .from(runners)
        .where(and(eq(runners.id, run.runnerId), eq(runners.ownership, 'platform')))
        .limit(1);
      if (!runner) return { admitted: false, reason: 'run_capacity_runner_missing' };
      if (
        !this.localRunnerName
        || runner.name !== this.localRunnerName
        || !this.localHostFingerprint
        || runner.hostFingerprint !== this.localHostFingerprint
      ) {
        return { admitted: false, reason: 'worker_runner_affinity_mismatch' };
      }
      const [existing] = await tx
        .select()
        .from(capacityLeases)
        .where(
          and(
            eq(capacityLeases.runId, run.id),
            eq(capacityLeases.workerTaskId, params.workerTaskId),
            inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
          ),
        )
        .limit(1);
      if (existing) {
        return {
          admitted: true,
          leaseId: existing.id,
          includedInBundle: existing.purpose === 'minimum_worker',
        };
      }
      if (runner.schedulingMode !== 'accepting') {
        return { admitted: false, reason: 'worker_admission_held' };
      }
      if (runner.status !== 'online') {
        return { admitted: false, reason: `worker_runner_${runner.status}` };
      }
      if (
        !runner.lastHeartbeatAt
        || this.now().getTime() - runner.lastHeartbeatAt.getTime() > this.config.heartbeatMaxAgeMs
      ) {
        return { admitted: false, reason: 'worker_runner_heartbeat_stale' };
      }

      const [baseLease] = await tx
        .select()
        .from(capacityLeases)
        .where(
          and(
            eq(capacityLeases.runId, run.id),
            eq(capacityLeases.admissionEpoch, run.admissionEpoch),
            inArray(capacityLeases.purpose, ['control', 'execution_base']),
            inArray(capacityLeases.state, ['held', 'active']),
            sql`${capacityLeases.parentLeaseId} IS NULL`,
          ),
        )
        .limit(1);
      if (!baseLease) return { admitted: false, reason: 'run_capacity_lease_missing' };

      const [workerUsage] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(capacityLeases)
        .where(
          and(
            eq(capacityLeases.runId, run.id),
            eq(capacityLeases.admissionEpoch, run.admissionEpoch),
            inArray(capacityLeases.purpose, ['minimum_worker', 'optional_worker']),
            inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
          ),
        );
      const includedWorkerSlots = Math.max(0, baseLease.containerSlots - 1);
      const usesIncludedSlot = Number(workerUsage?.count ?? 0) < includedWorkerSlots;
      const workerProfile = this.config.profiles.standard;

      if (!usesIncludedSlot) {
        const memoryLimit = Math.min(
          runner.detectedMemoryMb ?? 0,
          snapshotNumber(runner.healthSnapshot, 'admissionMemoryMb') ?? 0,
        );
        const slotLimit = runner.detectedContainerSlots ?? 0;
        const [usage] = await tx
          .select({
            memoryMb: sql<number>`COALESCE(sum(${capacityLeases.memoryMb}), 0)::int`,
            containerSlots: sql<number>`COALESCE(sum(${capacityLeases.containerSlots}), 0)::int`,
          })
          .from(capacityLeases)
          .where(and(eq(capacityLeases.runnerId, runner.id), inArray(capacityLeases.state, [...LIVE_LEASE_STATES])));
        if (
          Number(usage?.memoryMb ?? 0) + workerProfile.memoryMb > memoryLimit ||
          Number(usage?.containerSlots ?? 0) + workerProfile.containerSlots > slotLimit
        ) {
          await tx.insert(runEvents).values({
            runId: run.id,
            type: 'run.child_capacity_waiting',
            note: `workerTaskId=${params.workerTaskId}`,
          });
          return { admitted: false, reason: 'worker_waiting_for_capacity' };
        }
      }

      const now = this.now();
      const [lease] = await tx
        .insert(capacityLeases)
        .values({
          runnerId: runner.id,
          runId: run.id,
          admissionEpoch: run.admissionEpoch,
          parentLeaseId: baseLease.id,
          bundleKey: `worker:${params.workerTaskId}`,
          purpose: usesIncludedSlot ? 'minimum_worker' : 'optional_worker',
          profileKey: 'standard',
          profileVersion: workerProfile.version,
          memoryMb: usesIncludedSlot ? 0 : workerProfile.memoryMb,
          containerSlots: usesIncludedSlot ? 0 : workerProfile.containerSlots,
          cpuMillis: usesIncludedSlot ? null : workerProfile.cpuMillis,
          pidLimit: usesIncludedSlot ? null : workerProfile.pidLimit,
          state: 'active',
          workerTaskId: params.workerTaskId,
          reason: usesIncludedSlot ? 'included_minimum_worker' : 'optional_worker_admission',
          acquiredAt: now,
          activatedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: capacityLeases.id });
      if (!lease) throw new AppError(ERROR_CODES.INTERNAL_UNEXPECTED, 'Failed to acquire worker capacity');
      await tx.insert(runEvents).values({
        runId: run.id,
        type: 'run.child_capacity_acquired',
        note: `workerTaskId=${params.workerTaskId};lease=${lease.id};included=${usesIncludedSlot}`,
      });
      return {
        admitted: true,
        leaseId: lease.id,
        includedInBundle: usesIncludedSlot,
      };
    });
  }

  async releaseWorkerCapacity(params: { runId: string; workerTaskId: string; reason: string }): Promise<void> {
    const live = await this.db
      .select({ id: capacityLeases.id })
      .from(capacityLeases)
      .where(
        and(
          eq(capacityLeases.runId, params.runId),
          eq(capacityLeases.workerTaskId, params.workerTaskId),
          inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
        ),
      );
    for (const lease of live) {
      await this.beginRelease(lease.id, params.reason);
      await this.completeRelease(lease.id, params.reason);
    }
  }

  async beginRelease(leaseId: string, reason: string): Promise<void> {
    await this.db
      .update(capacityLeases)
      .set({ state: 'releasing', reason, updatedAt: this.now() })
      .where(and(eq(capacityLeases.id, leaseId), inArray(capacityLeases.state, ['held', 'active'])));
  }

  async completeRelease(leaseId: string, reason: string): Promise<void> {
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const [released] = await tx
        .update(capacityLeases)
        .set({ state: 'released', reason, releasedAt: now, updatedAt: now })
        .where(and(eq(capacityLeases.id, leaseId), eq(capacityLeases.state, 'releasing')))
        .returning({
          runId: capacityLeases.runId,
          purpose: capacityLeases.purpose,
          workerTaskId: capacityLeases.workerTaskId,
        });
      if (!released) return;
      const child = released.purpose === 'minimum_worker' || released.purpose === 'optional_worker';
      await tx.insert(runEvents).values({
        runId: released.runId,
        type: child ? 'run.child_capacity_released' : 'run.admission_released',
        note: child
          ? `workerTaskId=${released.workerTaskId ?? 'unknown'};lease=${leaseId};reason=${reason}`
          : `lease=${leaseId};reason=${reason}`,
      });
    });
  }
}
