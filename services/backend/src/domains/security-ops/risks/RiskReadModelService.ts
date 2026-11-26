import { and, desc, eq, notExists, sql, type SQL } from 'drizzle-orm';

import { db, type DatabaseClient } from '@/db/client';
import {
  advisories,
  assets,
  exposureMatches,
  findings,
  inventoryComponents,
  scopes,
  type ExposureMatchState,
  type RiskSourceKind,
  type RiskState,
} from '@/db/schema';
import { assetInScopeClause } from '@/domains/security-ops/assets/assetScopeFilter';

export const OPEN_RISK_STATES = [
  'potential',
  'verifying',
  'confirmed',
  'not_reproduced',
] as const satisfies readonly RiskState[];

export type RiskRecordKind = 'finding' | 'exposure';

export type RiskListItem = {
  key: string;
  id: string;
  recordKind: RiskRecordKind;
  sourceKind?: RiskSourceKind;
  title: string;
  subtitle: string | null;
  severity: string;
  state: RiskState;
  assetValue: string | null;
  cvssScore: number | null;
  kevListed?: boolean;
  backportRisk?: boolean;
  versionConflict?: boolean;
};

export type RiskSummary = {
  total: number;
  open: number;
  openKev: number;
  byState: Record<RiskState, number>;
  bySeverity: Record<string, number>;
  openBySeverity: Record<string, number>;
};

export type FindingRiskSourceRow = {
  id: string;
  title: string;
  severity: string;
  state: RiskState;
  sourceKind: RiskSourceKind;
  repositoryId: string | null;
  assetValue: string | null;
  scopeName: string | null;
  cvssScore: number | null;
  lastSeenAt: Date | string | null;
};

export type ExposureRiskSourceRow = {
  id: string;
  riskId: string | null;
  state: ExposureMatchState;
  advisoryId: string;
  severity: string | null;
  cvssScore: number | null;
  kevListed: boolean;
  componentName: string | null;
  componentVersion: string | null;
  backportRisk: boolean;
  versionConflict: boolean;
  assetValue: string | null;
  inventoryObservedAt: Date | string | null;
  firstSeenAt: Date | string | null;
};

export type RiskCountSourceRow = {
  state: RiskState;
  severity: string;
  count: number | string;
  kevCount: number | string;
};

export type RiskSourceReader = {
  listFindings(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<FindingRiskSourceRow[]>;
  listExposures(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<ExposureRiskSourceRow[]>;
  summarizeFindings(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<RiskCountSourceRow[]>;
  summarizeExposures(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<RiskCountSourceRow[]>;
};

type SortableRisk = RiskListItem & { sortAt: number };

const FINDING_LIMIT = 500;
const EXPOSURE_LIMIT = 100;

const exposureRiskStateExpression = (): SQL<RiskState> => sql<RiskState>`case
  when ${exposureMatches.state} = 'verifying' then 'verifying'
  when ${exposureMatches.state} = 'confirmed' then 'confirmed'
  when ${exposureMatches.state} in ('not_reproduced', 'inconclusive') then 'not_reproduced'
  when ${exposureMatches.state} in ('dismissed', 'stale') then 'dismissed'
  when ${exposureMatches.state} = 'resolved' then 'resolved'
  else 'potential'
end`;

const toTime = (value: Date | string | null | undefined): number => {
  if (value instanceof Date) return value.getTime();
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

export const findingRiskState = (row: Pick<FindingRiskSourceRow, 'state'>): RiskState => row.state;

export const exposureRiskState = (state: ExposureMatchState): RiskState => {
  switch (state) {
    case 'verifying':
      return 'verifying';
    case 'confirmed':
      return 'confirmed';
    case 'not_reproduced':
    case 'inconclusive':
      return 'not_reproduced';
    case 'dismissed':
    case 'stale':
      return 'dismissed';
    case 'resolved':
      return 'resolved';
    default:
      return 'potential';
  }
};

const findingToRisk = (row: FindingRiskSourceRow): SortableRisk => ({
  key: `finding:${row.id}`,
  id: row.id,
  recordKind: 'finding',
  sourceKind: row.sourceKind,
  title: row.title,
  subtitle: row.sourceKind === 'code_review' ? row.repositoryId : row.scopeName,
  severity: row.severity,
  state: findingRiskState(row),
  assetValue: row.assetValue,
  cvssScore: row.cvssScore,
  sortAt: toTime(row.lastSeenAt),
});

const exposureToRisk = (row: ExposureRiskSourceRow): SortableRisk => {
  const component = [row.componentName, row.componentVersion].filter(Boolean).join(' ') || 'component';
  return {
    key: `exposure:${row.id}`,
    id: row.id,
    recordKind: 'exposure',
    title: `${row.advisoryId} in ${component}`,
    subtitle: null,
    severity: row.severity ?? 'medium',
    state: exposureRiskState(row.state),
    assetValue: row.assetValue,
    cvssScore: row.cvssScore,
    kevListed: row.kevListed,
    backportRisk: row.backportRisk,
    versionConflict: row.versionConflict,
    sortAt: toTime(row.inventoryObservedAt ?? row.firstSeenAt),
  };
};

export const mergeRiskSources = (
  findingRows: FindingRiskSourceRow[],
  exposureRows: ExposureRiskSourceRow[],
): RiskListItem[] => {
  const visibleFindingIds = new Set(findingRows.map((row) => row.id));
  const rows: SortableRisk[] = [
    ...findingRows.map(findingToRisk),
    ...exposureRows
      .filter((row) => row.riskId == null || !visibleFindingIds.has(row.riskId))
      .map(exposureToRisk),
  ];

  return rows
    .sort((left, right) => right.sortAt - left.sortAt)
    .map(({ sortAt: _sortAt, ...row }) => row);
};

const emptyStateCounts = (): Record<RiskState, number> => ({
  potential: 0,
  verifying: 0,
  confirmed: 0,
  not_reproduced: 0,
  dismissed: 0,
  resolved: 0,
  accepted: 0,
});

export const summarizeRiskCountRows = (
  findingRows: RiskCountSourceRow[],
  exposureRows: RiskCountSourceRow[],
): RiskSummary => {
  const byState = emptyStateCounts();
  const bySeverity: Record<string, number> = {};
  const openBySeverity: Record<string, number> = {};
  const openStates = new Set<RiskState>(OPEN_RISK_STATES);
  let total = 0;
  let open = 0;
  let openKev = 0;

  for (const row of [...findingRows, ...exposureRows]) {
    const rowCount = Number(row.count ?? 0);
    const kevCount = Number(row.kevCount ?? 0);
    if (!Number.isFinite(rowCount) || rowCount <= 0) continue;

    total += rowCount;
    byState[row.state] += rowCount;
    bySeverity[row.severity] = (bySeverity[row.severity] ?? 0) + rowCount;
    if (openStates.has(row.state)) {
      open += rowCount;
      openKev += Number.isFinite(kevCount) && kevCount > 0 ? kevCount : 0;
      openBySeverity[row.severity] = (openBySeverity[row.severity] ?? 0) + rowCount;
    }
  }

  return { total, open, openKev, byState, bySeverity, openBySeverity };
};

export class DrizzleRiskSourceReader implements RiskSourceReader {
  constructor(private readonly database: DatabaseClient = db) {}

  private exposureClauses(params: {
    organizationId: string;
    scopeId?: string | null;
  }): SQL[] {
    const clauses: SQL[] = [eq(exposureMatches.organizationId, params.organizationId)];
    if (params.scopeId) clauses.push(assetInScopeClause(params.scopeId));

    const linkedFindingClauses: SQL[] = [
      eq(findings.id, exposureMatches.riskId),
      eq(findings.organizationId, params.organizationId),
    ];
    if (params.scopeId) linkedFindingClauses.push(eq(findings.scopeId, params.scopeId));
    clauses.push(
      notExists(
        this.database
          .select({ one: sql<number>`1` })
          .from(findings)
          .where(and(...linkedFindingClauses)),
      ),
    );

    return clauses;
  }

  async listFindings(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<FindingRiskSourceRow[]> {
    const clauses: SQL[] = [eq(findings.organizationId, params.organizationId)];
    if (params.scopeId) clauses.push(eq(findings.scopeId, params.scopeId));

    return this.database
      .select({
        id: findings.id,
        title: findings.title,
        severity: findings.severity,
        state: findings.state,
        sourceKind: findings.sourceKind,
        repositoryId: findings.repositoryId,
        assetValue: assets.value,
        scopeName: scopes.name,
        cvssScore: findings.cvssScore,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .leftJoin(assets, eq(assets.id, findings.assetId))
      .innerJoin(scopes, eq(scopes.id, findings.scopeId))
      .where(and(...clauses))
      .orderBy(desc(findings.lastSeenAt))
      .limit(FINDING_LIMIT);
  }

  async listExposures(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<ExposureRiskSourceRow[]> {
    const clauses = this.exposureClauses(params);

    return this.database
      .select({
        id: exposureMatches.id,
        riskId: exposureMatches.riskId,
        state: exposureMatches.state,
        advisoryId: advisories.canonicalId,
        severity: advisories.severity,
        cvssScore: advisories.cvssV31Score,
        kevListed: advisories.kevListed,
        componentName: inventoryComponents.displayName,
        componentVersion: inventoryComponents.resolvedVersion,
        backportRisk: inventoryComponents.backportRisk,
        versionConflict: inventoryComponents.versionConflict,
        assetValue: assets.value,
        inventoryObservedAt: exposureMatches.inventoryObservedAt,
        firstSeenAt: exposureMatches.firstSeenAt,
      })
      .from(exposureMatches)
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .innerJoin(inventoryComponents, eq(inventoryComponents.id, exposureMatches.componentId))
      .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
      .where(and(...clauses))
      .orderBy(desc(exposureMatches.priorityScore))
      .limit(EXPOSURE_LIMIT);
  }

  async summarizeFindings(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<RiskCountSourceRow[]> {
    const clauses: SQL[] = [eq(findings.organizationId, params.organizationId)];
    if (params.scopeId) clauses.push(eq(findings.scopeId, params.scopeId));
    const state = findings.state;

    return this.database
      .select({
        state,
        severity: findings.severity,
        count: sql<number>`count(*)::int`,
        kevCount: sql<number>`0::int`,
      })
      .from(findings)
      .where(and(...clauses))
      .groupBy(state, findings.severity);
  }

  async summarizeExposures(params: {
    organizationId: string;
    scopeId?: string | null;
  }): Promise<RiskCountSourceRow[]> {
    const clauses = this.exposureClauses(params);

    const state = exposureRiskStateExpression();
    const severity = sql<string>`coalesce(${advisories.severity}, 'medium')`;
    return this.database
      .select({
        state,
        severity,
        count: sql<number>`count(*)::int`,
        kevCount: sql<number>`count(*) filter (where ${advisories.kevListed} = true)::int`,
      })
      .from(exposureMatches)
      .innerJoin(advisories, eq(advisories.id, exposureMatches.advisoryId))
      .innerJoin(assets, eq(assets.id, exposureMatches.assetId))
      .where(and(...clauses))
      .groupBy(state, severity);
  }
}

export class RiskReadModelService {
  constructor(private readonly sources: RiskSourceReader = new DrizzleRiskSourceReader()) {}

  async list(params: {
    organizationId: string;
    scopeId?: string | null;
    includeExposures: boolean;
  }): Promise<RiskListItem[]> {
    const [findingRows, exposureRows] = await Promise.all([
      this.sources.listFindings(params),
      params.includeExposures ? this.sources.listExposures(params) : Promise.resolve([]),
    ]);
    return mergeRiskSources(findingRows, exposureRows);
  }

  async summarize(params: {
    organizationId: string;
    scopeId?: string | null;
    includeExposures: boolean;
  }): Promise<RiskSummary> {
    const [findingRows, exposureRows] = await Promise.all([
      this.sources.summarizeFindings(params),
      params.includeExposures ? this.sources.summarizeExposures(params) : Promise.resolve([]),
    ]);
    return summarizeRiskCountRows(findingRows, exposureRows);
  }

  async read(params: {
    organizationId: string;
    scopeId?: string | null;
    includeExposures: boolean;
  }): Promise<{ risks: RiskListItem[]; summary: RiskSummary }> {
    const [risks, summary] = await Promise.all([
      this.list(params),
      this.summarize(params),
    ]);
    return { risks, summary };
  }
}
