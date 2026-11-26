import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { DatabaseClient } from '@/db/client';
import {
  runPhases,
  type NewRunPhaseRow,
  type RunPhaseRow,
} from '@/db/schema';
import type { MissionEnvelopeNode } from '@/domains/agent-brain/domain/workers/missionEnvelope';
import {
  attachMissionPhases,
  phaseProfileRegistry,
  type RunPhaseKey,
  type RunPhaseStatus,
} from './PhaseProfileRegistry';

const normalizeSkillSlug = (value: string): string => value.trim().toLowerCase();

const uniqueSkillSlugs = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSkillSlug(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

const terminalPhaseStatuses: ReadonlySet<RunPhaseStatus> = new Set([
  'completed',
  'blocked',
  'failed',
  'timed_out',
  'aborted',
]);

const openPhaseStatuses: RunPhaseStatus[] = ['pending', 'active', 'handoff_submitted'];
// Existing run_phases rows still have a non-null legacy column, but it is not a runtime switch.
const INERT_PHASE_DELEGATION_MODE = 'solo';

type PhaseGroup = {
  phaseKey: RunPhaseKey;
  stepIds: string[];
  assignedSkillSlugs: string[];
};

const profileForGroup = (group: PhaseGroup) => {
  return phaseProfileRegistry.get(group.phaseKey);
};

const CANONICAL_PHASE_ORDER: readonly RunPhaseKey[] = [
  'planning',
  'review_mapping',
  'review_analysis',
  'review_validation',
  'review_reporting',
  'recon',
  'enumeration',
  'validation',
  'exploitation',
  'evidence',
  'control_assessment',
  'reporting',
];

export const groupMissionsByCanonicalPhase = (
  missions: readonly MissionEnvelopeNode[],
): PhaseGroup[] => {
  const groups = new Map<RunPhaseKey, PhaseGroup>();
  for (const mission of attachMissionPhases(missions)) {
    const phaseKey = mission.phase as RunPhaseKey;
    const current = groups.get(phaseKey);
    if (current) {
      current.stepIds.push(mission.id);
      current.assignedSkillSlugs = uniqueSkillSlugs([
        ...current.assignedSkillSlugs,
        ...(mission.assignedSkills ?? []),
      ]);
      continue;
    }
    groups.set(phaseKey, {
      phaseKey,
      stepIds: [mission.id],
      assignedSkillSlugs: uniqueSkillSlugs(mission.assignedSkills ?? []),
    });
  }
  return CANONICAL_PHASE_ORDER.flatMap((phaseKey) => {
    const group = groups.get(phaseKey);
    return group ? [group] : [];
  });
};

export class RunPhaseRepository {
  constructor(private readonly db: DatabaseClient) {}

  async listByRunId(runId: string): Promise<RunPhaseRow[]> {
    const rows = await this.db
      .select()
      .from(runPhases)
      .where(eq(runPhases.runId, runId))
      .orderBy(asc(runPhases.ordinal));

    return Array.isArray(rows) ? rows : [];
  }

  async replacePlanPhases(params: {
    runId: string;
    missions: readonly MissionEnvelopeNode[];
  }): Promise<RunPhaseRow[]> {
    const groups = groupMissionsByCanonicalPhase(params.missions);
    await this.db.delete(runPhases).where(eq(runPhases.runId, params.runId));
    if (groups.length === 0) {
      return [];
    }

    const values: NewRunPhaseRow[] = groups.map((group, index) => {
      const profile = profileForGroup(group);
      return {
        runId: params.runId,
        ordinal: index + 1,
        phaseKey: group.phaseKey,
        status: 'pending',
        sessionId: null,
        stepIds: group.stepIds,
        assignedSkillSlugs: group.assignedSkillSlugs.length > 0 ? group.assignedSkillSlugs : null,
        phaseProfile: profile.phaseProfile,
        toolProfile: profile.toolProfile,
        promptProfile: profile.promptProfile,
        delegationMode: INERT_PHASE_DELEGATION_MODE,
        handoffSchemaVersion: profile.handoffSchemaVersion,
        attempt: 1,
        maxAttempts: profile.maxAttempts,
      };
    });

    return this.db.insert(runPhases).values(values).returning();
  }

  async replaceFuturePlanPhases(params: {
    runId: string;
    missions: readonly MissionEnvelopeNode[];
  }): Promise<RunPhaseRow[]> {
    const existing = await this.listByRunId(params.runId);
    const deleteIds = existing
      .filter((row) => !row.sessionId && !terminalPhaseStatuses.has(row.status as RunPhaseStatus))
      .map((row) => row.id);

    if (deleteIds.length > 0) {
      await this.db.delete(runPhases).where(inArray(runPhases.id, deleteIds));
    }

    const nextOrdinal =
      existing
        .filter((row) => !deleteIds.includes(row.id))
        .reduce((max, row) => Math.max(max, row.ordinal), 0) + 1;
    const groups = groupMissionsByCanonicalPhase(params.missions);
    if (groups.length === 0) {
      return [];
    }

    const values: NewRunPhaseRow[] = groups.map((group, index) => {
      const profile = profileForGroup(group);
      return {
        runId: params.runId,
        ordinal: nextOrdinal + index,
        phaseKey: group.phaseKey,
        status: 'pending',
        sessionId: null,
        stepIds: group.stepIds,
        assignedSkillSlugs: group.assignedSkillSlugs.length > 0 ? group.assignedSkillSlugs : null,
        phaseProfile: profile.phaseProfile,
        toolProfile: profile.toolProfile,
        promptProfile: profile.promptProfile,
        delegationMode: INERT_PHASE_DELEGATION_MODE,
        handoffSchemaVersion: profile.handoffSchemaVersion,
        attempt: 1,
        maxAttempts: profile.maxAttempts,
      };
    });

    return this.db.insert(runPhases).values(values).returning();
  }

  async hasSessionHistory(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: runPhases.id })
      .from(runPhases)
      .where(and(eq(runPhases.runId, runId), isNotNull(runPhases.sessionId)))
      .limit(1);

    return Array.isArray(rows) && rows.length > 0;
  }

  async activatePhase(params: {
    phaseId: string;
    sessionId: string;
    handoffInRef?: string | null;
  }): Promise<RunPhaseRow | null> {
    const now = new Date();
    const [updated] = await this.db
      .update(runPhases)
      .set({
        status: 'active',
        sessionId: params.sessionId,
        delegationMode: INERT_PHASE_DELEGATION_MODE,
        ...(params.handoffInRef !== undefined ? { handoffInRef: params.handoffInRef } : {}),
        startedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(runPhases.id, params.phaseId),
        eq(runPhases.status, 'pending'),
        sql`NOT EXISTS (
          SELECT 1
          FROM run_phases active_phase
          WHERE active_phase.run_id = ${runPhases.runId}
            AND active_phase.phase_key = ${runPhases.phaseKey}
            AND active_phase.status = 'active'
            AND active_phase.id <> ${runPhases.id}
        )`,
      ))
      .returning();

    return updated ?? null;
  }

  async updateStatus(params: {
    phaseId: string;
    status: RunPhaseStatus;
    handoffOutRef?: string | null;
    checkpointRef?: string | null;
    lastError?: string | null;
  }): Promise<RunPhaseRow | null> {
    const now = new Date();
    const [updated] = await this.db
      .update(runPhases)
      .set({
        status: params.status,
        ...(params.handoffOutRef !== undefined ? { handoffOutRef: params.handoffOutRef } : {}),
        ...(params.checkpointRef !== undefined ? { checkpointRef: params.checkpointRef } : {}),
        ...(params.lastError !== undefined ? { lastError: params.lastError } : {}),
        ...(params.status === 'completed' ||
        params.status === 'blocked' ||
        params.status === 'failed' ||
        params.status === 'timed_out' ||
        params.status === 'aborted'
          ? { completedAt: now }
          : {}),
        updatedAt: now,
      })
      .where(eq(runPhases.id, params.phaseId))
      .returning();

    return updated ?? null;
  }

  async updateAssignedSkillSlugs(params: {
    phaseId: string;
    assignedSkillSlugs: readonly string[];
  }): Promise<RunPhaseRow | null> {
    const now = new Date();
    const normalized = uniqueSkillSlugs(params.assignedSkillSlugs);
    const [updated] = await this.db
      .update(runPhases)
      .set({
        assignedSkillSlugs: normalized.length > 0 ? normalized : null,
        updatedAt: now,
      })
      .where(eq(runPhases.id, params.phaseId))
      .returning();

    return updated ?? null;
  }

  async findActiveBySessionId(sessionId: string): Promise<RunPhaseRow | null> {
    const [row] = await this.db
      .select()
      .from(runPhases)
      .where(and(eq(runPhases.sessionId, sessionId), eq(runPhases.status, 'active')))
      .orderBy(asc(runPhases.ordinal))
      .limit(1);
    return row ?? null;
  }

  async findLatestBySessionId(sessionId: string): Promise<RunPhaseRow | null> {
    const [row] = await this.db
      .select()
      .from(runPhases)
      .where(eq(runPhases.sessionId, sessionId))
      .orderBy(desc(runPhases.ordinal))
      .limit(1);
    return row ?? null;
  }

  async findNextReadyPendingPhase(params: {
    runId: string;
    phaseKey: RunPhaseKey;
  }): Promise<RunPhaseRow | null> {
    const rows = await this.listByRunId(params.runId);
    const next = rows.find((row) => row.phaseKey === params.phaseKey && row.status === 'pending');
    if (!next) {
      return null;
    }

    const earlier = rows.filter((row) => row.ordinal < next.ordinal);
    const ready = earlier.every((row) => terminalPhaseStatuses.has(row.status as RunPhaseStatus) || row.status === 'handoff_submitted');
    return ready ? next : null;
  }

  async findNextReadyPendingPhaseIn(params: {
    runId: string;
    phaseKeys: readonly RunPhaseKey[];
  }): Promise<RunPhaseRow | null> {
    const allowedPhaseKeys = new Set(params.phaseKeys);
    const rows = await this.listByRunId(params.runId);
    const next = rows.find((row) =>
      allowedPhaseKeys.has(row.phaseKey as RunPhaseKey) && row.status === 'pending',
    );
    if (!next) {
      return null;
    }

    const earlier = rows.filter((row) => row.ordinal < next.ordinal);
    const ready = earlier.every((row) => terminalPhaseStatuses.has(row.status as RunPhaseStatus) || row.status === 'handoff_submitted');
    return ready ? next : null;
  }

  async findLatestHandoffBefore(params: {
    runId: string;
    ordinal: number;
  }): Promise<RunPhaseRow | null> {
    const rows = await this.listByRunId(params.runId);
    return rows
      .filter((row) => row.ordinal < params.ordinal && typeof row.handoffOutRef === 'string' && row.handoffOutRef.length > 0)
      .sort((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  }

  async hasOpenPhases(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: runPhases.id })
      .from(runPhases)
      .where(and(eq(runPhases.runId, runId), inArray(runPhases.status, openPhaseStatuses)))
      .limit(1);

    return Array.isArray(rows) && rows.length > 0;
  }

  async abortUnfinishedForRun(params: {
    runId: string;
    lastError?: string | null;
  }): Promise<RunPhaseRow[]> {
    const rows = await this.listByRunId(params.runId);
    const unfinished = rows.filter((row) => !terminalPhaseStatuses.has(row.status as RunPhaseStatus));
    const updatedRows: RunPhaseRow[] = [];

    for (const row of unfinished) {
      const updated = await this.updateStatus({
        phaseId: row.id,
        status: 'aborted',
        lastError: params.lastError ?? 'Run cancelled before phase completion',
      });
      if (updated) {
        updatedRows.push(updated);
      }
    }

    return updatedRows;
  }

  async listSessionIdsByRunId(runId: string): Promise<string[]> {
    const rows = await this.db
      .select({ sessionId: runPhases.sessionId })
      .from(runPhases)
      .where(and(eq(runPhases.runId, runId), isNotNull(runPhases.sessionId)));

    if (!Array.isArray(rows)) {
      return [];
    }

    return Array.from(
      new Set(
        rows
          .map((row) => row.sessionId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    );
  }
}
