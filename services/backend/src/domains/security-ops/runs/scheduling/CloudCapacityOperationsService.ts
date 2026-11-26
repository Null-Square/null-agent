import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import { capacityLeases, runners, runs, type RunSchedulingClass } from '@/db/schema';
import type { CloudRunSchedulingConfig } from './CloudRunSchedulingConfig';

const LIVE_LEASE_STATES = ['held', 'active', 'releasing'] as const;
const TERMINAL_RUN_STATES = ['completed', 'failed', 'cancelled'] as const;

export const OPERATOR_MODE_METADATA_KEY = 'cloudSchedulingOperatorMode';
const OPERATOR_ACTOR_METADATA_KEY = 'cloudSchedulingOperatorActor';
const OPERATOR_REASON_METADATA_KEY = 'cloudSchedulingOperatorReason';
const OPERATOR_UPDATED_METADATA_KEY = 'cloudSchedulingOperatorUpdatedAt';

export type CloudCapacityControlAction = 'hold' | 'drain' | 'resume';

export type CloudCapacityRunnerSnapshot = {
  id: string;
  name: string;
  status: string;
  schedulingMode: 'accepting' | 'hold' | 'draining';
  schedulingReason: string | null;
  operatorMode: 'hold' | 'draining' | null;
  hostFingerprint: string | null;
  fingerprintMatches: boolean;
  capacitySource: string | null;
  automaticCapacityReady: boolean;
  detectedMemoryMb: number | null;
  admissionMemoryMb: number | null;
  leasedMemoryMb: number;
  detectedContainerSlots: number | null;
  leasedContainerSlots: number;
  derivedActiveRuns: number | null;
  leasedActiveRuns: number;
  cleanupDisagreements: number;
  lastHeartbeatAt: string | null;
  heartbeatStale: boolean;
  healthSnapshot: Record<string, unknown> | null;
};

export type CloudCapacitySnapshot = {
  automaticAdmission: boolean;
  starvationThresholdMs: number;
  queue: {
    depth: number;
    oldestQueuedAt: string | null;
    oldestWaitMs: number;
    byClass: Record<RunSchedulingClass, number>;
  };
  cleanupDisagreements: number;
  runners: CloudCapacityRunnerSnapshot[];
};

const operatorModeFromMetadata = (metadata: Record<string, string> | null | undefined): 'hold' | 'draining' | null => {
  const value = metadata?.[OPERATOR_MODE_METADATA_KEY];
  return value === 'hold' || value === 'draining' ? value : null;
};

export class CloudCapacityOperationsService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly config: CloudRunSchedulingConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getSnapshot(): Promise<CloudCapacitySnapshot> {
    const now = this.now();
    const runnerRows = await this.db
      .select()
      .from(runners)
      .where(and(eq(runners.ownership, 'platform'), eq(runners.type, 'cloud')));

    const [queueRows, usageRows, disagreementRows] = await Promise.all([
      this.db
        .select({
          schedulingClass: runs.schedulingClass,
          count: sql<number>`count(*)::int`,
          oldestQueuedAt: sql<Date | null>`min(${runs.queuedAt})`,
        })
        .from(runs)
        .where(and(eq(runs.status, 'queued'), eq(runs.executionTarget, 'cloud'), isNull(runs.admittedAt)))
        .groupBy(runs.schedulingClass),
      this.db
        .select({
          runnerId: capacityLeases.runnerId,
          memoryMb: sql<number>`COALESCE(sum(${capacityLeases.memoryMb}), 0)::int`,
          containerSlots: sql<number>`COALESCE(sum(${capacityLeases.containerSlots}), 0)::int`,
          activeRuns: sql<number>`count(DISTINCT (${capacityLeases.runId}, ${capacityLeases.admissionEpoch}))::int`,
        })
        .from(capacityLeases)
        .where(inArray(capacityLeases.state, [...LIVE_LEASE_STATES]))
        .groupBy(capacityLeases.runnerId),
      this.db
        .select({
          runnerId: capacityLeases.runnerId,
          count: sql<number>`count(*)::int`,
        })
        .from(capacityLeases)
        .innerJoin(runs, eq(runs.id, capacityLeases.runId))
        .where(
          and(
            inArray(capacityLeases.state, [...LIVE_LEASE_STATES]),
            or(
              inArray(runs.status, [...TERMINAL_RUN_STATES]),
              and(
                eq(capacityLeases.state, 'releasing'),
                lt(capacityLeases.updatedAt, new Date(now.getTime() - this.config.heartbeatMaxAgeMs)),
              ),
            ),
          ),
        )
        .groupBy(capacityLeases.runnerId),
    ]);

    const byClass: Record<RunSchedulingClass, number> = { free: 0, paid: 0, pro: 0, internal: 0 };
    let oldestQueuedAt: Date | null = null;
    let depth = 0;
    for (const row of queueRows) {
      const count = Number(row.count ?? 0);
      depth += count;
      if (row.schedulingClass && row.schedulingClass in byClass) byClass[row.schedulingClass] += count;
      const parsedOldest = row.oldestQueuedAt instanceof Date
        ? row.oldestQueuedAt
        : row.oldestQueuedAt
          ? new Date(String(row.oldestQueuedAt))
          : null;
      if (parsedOldest && !Number.isNaN(parsedOldest.getTime()) && (!oldestQueuedAt || parsedOldest < oldestQueuedAt)) {
        oldestQueuedAt = parsedOldest;
      }
    }

    const usageByRunner = new Map(usageRows.map((row) => [row.runnerId, row]));
    const disagreementsByRunner = new Map(disagreementRows.map((row) => [row.runnerId, Number(row.count ?? 0)]));
    const snapshots = runnerRows.map((runner): CloudCapacityRunnerSnapshot => {
      const usage = usageByRunner.get(runner.id);
      const cleanupDisagreements = disagreementsByRunner.get(runner.id) ?? 0;
      const lastHeartbeatAt = runner.lastHeartbeatAt?.toISOString() ?? null;
      const reportedFingerprint = typeof runner.healthSnapshot?.['reportedFingerprint'] === 'string'
        ? runner.healthSnapshot['reportedFingerprint']
        : null;
      const fingerprintMatches = Boolean(runner.hostFingerprint && runner.hostFingerprint === reportedFingerprint);
      const reliable = runner.healthSnapshot?.['reliable'] === true;
      const admissionMemoryMb = typeof runner.healthSnapshot?.['admissionMemoryMb'] === 'number'
        ? runner.healthSnapshot['admissionMemoryMb']
        : null;
      const automaticCapacityReady = Boolean(
        reliable
        && fingerprintMatches
        && runner.capacitySource === 'docker_daemon'
        && runner.detectedMemoryMb
        && runner.detectedContainerSlots
        && runner.derivedActiveRunLimit,
      );
      return {
        id: runner.id,
        name: runner.name,
        status: runner.status,
        schedulingMode: runner.schedulingMode,
        schedulingReason: runner.schedulingReason,
        operatorMode: operatorModeFromMetadata(runner.metadata),
        hostFingerprint: runner.hostFingerprint,
        fingerprintMatches,
        capacitySource: runner.capacitySource,
        automaticCapacityReady,
        detectedMemoryMb: runner.detectedMemoryMb,
        admissionMemoryMb,
        leasedMemoryMb: Number(usage?.memoryMb ?? 0),
        detectedContainerSlots: runner.detectedContainerSlots,
        leasedContainerSlots: Number(usage?.containerSlots ?? 0),
        derivedActiveRuns: runner.derivedActiveRunLimit,
        leasedActiveRuns: Number(usage?.activeRuns ?? 0),
        cleanupDisagreements,
        lastHeartbeatAt,
        heartbeatStale: !runner.lastHeartbeatAt
          || now.getTime() - runner.lastHeartbeatAt.getTime() > this.config.heartbeatMaxAgeMs,
        healthSnapshot: runner.healthSnapshot ?? null,
      };
    });

    return {
      automaticAdmission: this.config.queueCloudRuns,
      starvationThresholdMs: this.config.planStarvationMs,
      queue: {
        depth,
        oldestQueuedAt: oldestQueuedAt?.toISOString() ?? null,
        oldestWaitMs: oldestQueuedAt ? Math.max(0, now.getTime() - oldestQueuedAt.getTime()) : 0,
        byClass,
      },
      cleanupDisagreements: snapshots.reduce((total, runner) => total + runner.cleanupDisagreements, 0),
      runners: snapshots,
    };
  }

  async controlRunner(params: {
    runnerId: string;
    action: CloudCapacityControlAction;
    actorUserId: string;
    reason: string;
  }): Promise<CloudCapacityRunnerSnapshot | null> {
    const now = this.now();
    const changed = await this.db.transaction(async (tx) => {
      const [runner] = await tx
        .select()
        .from(runners)
        .where(and(eq(runners.id, params.runnerId), eq(runners.ownership, 'platform'), eq(runners.type, 'cloud')))
        .limit(1)
        .for('update');
      if (!runner) return false;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity-runner:${runner.id}`}, 0))`);

      const metadata = { ...(runner.metadata ?? {}) };
      if (params.action === 'resume') {
        delete metadata[OPERATOR_MODE_METADATA_KEY];
      } else {
        metadata[OPERATOR_MODE_METADATA_KEY] = params.action === 'drain' ? 'draining' : 'hold';
      }
      metadata[OPERATOR_ACTOR_METADATA_KEY] = params.actorUserId;
      metadata[OPERATOR_REASON_METADATA_KEY] = params.reason;
      metadata[OPERATOR_UPDATED_METADATA_KEY] = now.toISOString();
      await tx
        .update(runners)
        .set({
          metadata,
          schedulingMode: params.action === 'drain' ? 'draining' : 'hold',
          schedulingReason: params.action === 'resume'
            ? 'operator_resume_pending_heartbeat'
            : params.action === 'drain'
              ? 'operator_draining'
              : 'operator_hold',
          updatedAt: now,
        })
        .where(eq(runners.id, runner.id));
      return true;
    });
    if (!changed) return null;
    return (await this.getSnapshot()).runners.find((runner) => runner.id === params.runnerId) ?? null;
  }
}
