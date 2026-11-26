import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

import { setupTestDb } from '../../helpers/testDb';
import { users, organizations, agentSessions, runs, runPhases } from '@/db/schema';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import { isReportingHandoffRecorded } from '@/domains/agent-brain/adapters/tools/builtins/securityops';

/**
 * Integration coverage for the finalize-gate authoritative source (H-2026-05-28-001).
 *
 * The finalize gate falls back to the DB handoff record when the in-memory
 * `phaseHandoffSubmitted` flag is lost across the handoff -> finalize model-call
 * boundary. This test exercises the exact composition that fallback uses against a
 * real database: `RunPhaseRepository.listByRunId()` -> `isReportingHandoffRecorded()`.
 *
 * It proves the `run_phases.handoff_out_ref` column round-trips through the
 * repository as `handoffOutRef` and that the decision is correct on real rows.
 */
const maybeDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('finalize handoff gate — authoritative DB source (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let skip = false;

  beforeAll(async () => {
    try {
      harness = await setupTestDb();
      if (!harness) skip = true;
    } catch {
      skip = true;
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip || !harness) return;
      await fn();
    });

  const seedReportingRun = async (params: {
    reportingHandoffRef: string | null;
    enumerationHandoffRef?: string | null;
  }): Promise<{ runId: string; reportingPhaseId: string }> => {
    const db = harness!.db as any;

    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `finalize-gate-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`,
      password_hash: 'test',
    });

    const [{ id: organizationId }] = await db
      .insert(organizations)
      .values({
        name: 'Finalize Gate Org',
        slug: `finalize-gate-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      })
      .returning({ id: organizations.id });

    // Scope columns vary by migration; insert the minimal required set defensively.
    const scopeColumnsResult = await harness!.pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'scopes'
    `);
    const scopeColumns = new Set(scopeColumnsResult.rows.map((row) => row.column_name));
    const insertColumns = ['organization_id', 'name'];
    const insertValues: Array<string | boolean> = [organizationId, 'Finalize Gate Scope'];
    if (scopeColumns.has('user_id')) { insertColumns.push('user_id'); insertValues.push(userId); }
    if (scopeColumns.has('kind')) { insertColumns.push('kind'); insertValues.push('domain'); }
    if (scopeColumns.has('safe_mode')) { insertColumns.push('safe_mode'); insertValues.push(true); }
    if (scopeColumns.has('status')) { insertColumns.push('status'); insertValues.push('active'); }
    const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(', ');
    const scopeInsert = await harness!.pool.query<{ id: string }>(
      `INSERT INTO scopes (${insertColumns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      insertValues,
    );
    const scopeId = scopeInsert.rows[0]!.id;

    const [{ id: sessionId }] = await db
      .insert(agentSessions)
      .values({ userId, workspaceDir: `/tmp/finalize-gate-${randomUUID()}` })
      .returning({ id: agentSessions.id });

    const [{ id: runId }] = await db
      .insert(runs)
      .values({ organizationId, scopeId, userId, sessionId, goal: 'finalize gate integration', status: 'running' })
      .returning({ id: runs.id });

    // Enumeration phase (precedes reporting). Optionally has its own handoff ref to
    // prove the gate does not treat a non-reporting handoff as the reporting handoff.
    await db.insert(runPhases).values({
      runId,
      ordinal: 1,
      phaseKey: 'enumeration',
      status: 'completed',
      phaseProfile: 'phase-enumeration',
      toolProfile: 'enumeration',
      promptProfile: 'phase-enumeration',
      handoffOutRef: params.enumerationHandoffRef ?? null,
    });

    const [{ id: reportingPhaseId }] = await db
      .insert(runPhases)
      .values({
        runId,
        ordinal: 2,
        phaseKey: 'reporting',
        status: params.reportingHandoffRef ? 'completed' : 'active',
        phaseProfile: 'phase-reporting',
        toolProfile: 'reporting',
        promptProfile: 'phase-reporting',
        handoffOutRef: params.reportingHandoffRef,
      })
      .returning({ id: runPhases.id });

    return { runId, reportingPhaseId };
  };

  itMaybe('accepts when the reporting phase recorded handoff_out_ref (flag-loss recovery)', async () => {
    const { runId, reportingPhaseId } = await seedReportingRun({
      reportingHandoffRef: '.artifacts/phase-handoffs/reporting-done.json',
    });

    const phases = await new RunPhaseRepository(harness!.db as any).listByRunId(runId);

    // The repository must surface the column as handoffOutRef for the gate to read it.
    const reporting = phases.find((p) => p.id === reportingPhaseId);
    expect(reporting?.handoffOutRef).toBe('.artifacts/phase-handoffs/reporting-done.json');

    // This is what the gate's DB fallback computes when the in-memory flag is absent.
    expect(isReportingHandoffRecorded(phases, reportingPhaseId)).toBe(true);
  });

  itMaybe('rejects when the reporting phase has no handoff_out_ref yet', async () => {
    const { runId, reportingPhaseId } = await seedReportingRun({
      reportingHandoffRef: null,
      // Enumeration DID hand off — must not be mistaken for the reporting handoff.
      enumerationHandoffRef: '.artifacts/phase-handoffs/enum-done.json',
    });

    const phases = await new RunPhaseRepository(harness!.db as any).listByRunId(runId);
    expect(isReportingHandoffRecorded(phases, reportingPhaseId)).toBe(false);
  });
});
