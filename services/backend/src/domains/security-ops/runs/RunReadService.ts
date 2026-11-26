import { desc, eq, inArray } from 'drizzle-orm';
import type { DatabaseClient } from '@/db/client';
import {
  assetObservations,
  assets,
  findingEvidence,
  findings,
  runEvents,
  runs,
  type RunEventRow,
  type RunRow,
} from '@/db/schema';
import { RunPhaseRepository } from './RunPhaseRepository';

export class RunReadService {
  private readonly runPhaseRepository: RunPhaseRepository;

  constructor(
    private readonly db: DatabaseClient,
    runPhaseRepository?: RunPhaseRepository,
  ) {
    this.runPhaseRepository = runPhaseRepository ?? new RunPhaseRepository(this.db);
  }

  async getEvents(runId: string): Promise<RunEventRow[]> {
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.createdAt);
  }

  async getFindings(runId: string): Promise<unknown[]> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) return [];

    const sessionIds = await this.collectRunNoteSessionIds(run);
    if (sessionIds.length === 0) return [];

    const findingRefRows = await this.db
      .selectDistinct({ findingId: findingEvidence.findingId })
      .from(findingEvidence)
      .where(inArray(findingEvidence.sessionId, sessionIds));

    const findingIds = findingRefRows.map((row) => row.findingId).filter(Boolean) as string[];
    if (findingIds.length === 0) return [];

    const rows = await this.db
      .select({
        finding: findings,
        assetValue: assets.value,
        assetKind: assets.kind,
      })
      .from(findings)
      .leftJoin(assets, eq(assets.id, findings.assetId))
      .where(inArray(findings.id, findingIds))
      .orderBy(desc(findings.lastSeenAt));

    return rows.map(({ finding, assetValue, assetKind }) => ({
      ...finding,
      assetValue: assetValue ?? '-',
      assetKind: assetKind ?? 'unknown',
      firstSeenAt: finding.firstSeenAt instanceof Date ? finding.firstSeenAt.toISOString() : finding.firstSeenAt,
      lastSeenAt: finding.lastSeenAt instanceof Date ? finding.lastSeenAt.toISOString() : finding.lastSeenAt,
      createdAt: finding.createdAt instanceof Date ? finding.createdAt.toISOString() : finding.createdAt,
    }));
  }

  async getInventoryDiff(runId: string): Promise<{ added: unknown[]; removed: unknown[] }> {
    const [run] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);

    if (!run) return { added: [], removed: [] };

    const sessionIds = await this.collectRunNoteSessionIds(run);
    if (sessionIds.length === 0) return { added: [], removed: [] };

    const observed = await this.db
      .select({ asset: assets })
      .from(assetObservations)
      .innerJoin(assets, eq(assets.id, assetObservations.assetId))
      .where(inArray(assetObservations.sessionId, sessionIds));

    const addedMap = new Map<string, unknown>();
    for (const row of observed) {
      addedMap.set(row.asset.id, {
        ...row.asset,
        firstSeenAt: row.asset.firstSeenAt instanceof Date ? row.asset.firstSeenAt.toISOString() : row.asset.firstSeenAt,
        lastSeenAt: row.asset.lastSeenAt instanceof Date ? row.asset.lastSeenAt.toISOString() : row.asset.lastSeenAt,
      });
    }

    return {
      added: Array.from(addedMap.values()),
      removed: [],
    };
  }

  private async collectRunNoteSessionIds(run: RunRow): Promise<string[]> {
    const ids = new Set<string>();
    if (typeof run.sessionId === 'string' && run.sessionId.length > 0) {
      ids.add(run.sessionId);
    }
    if (typeof run.plannerSessionId === 'string' && run.plannerSessionId.length > 0) {
      ids.add(run.plannerSessionId);
    }
    if (typeof run.executorSessionId === 'string' && run.executorSessionId.length > 0) {
      ids.add(run.executorSessionId);
    }
    for (const phaseSessionId of await this.runPhaseRepository.listSessionIdsByRunId(run.id)) {
      ids.add(phaseSessionId);
    }
    return Array.from(ids);
  }
}
