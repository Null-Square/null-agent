import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  findingEvents,
  findings,
} from '@/db/schema';
import { SessionRepository } from '@/domains/agent-brain/adapters/persistence';
import { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import { TimelineService } from '@/domains/agent-brain/infrastructure/telemetry/TimelineService';
import { type OrganizationService } from '@/domains/security-ops/organization/OrganizationService';
import { type ComplianceReadinessService } from '@/domains/security-ops/compliance/ComplianceReadinessService';
import { RunActivityService } from '@/domains/security-ops/runs/RunActivityService';
import { RunPhaseRepository } from '@/domains/security-ops/runs/RunPhaseRepository';
import { ValidationQueueRepository } from '@/domains/security-ops/runs/ValidationQueueRepository';
import { WorkspaceProxyCaptureSource } from '@/domains/security-ops/runs/WorkspaceProxyCaptureSource';
import type { S3StorageService } from '@/shared/storage/S3StorageService';

export type DashboardRouteDeps = {
  orgService?: Pick<OrganizationService, 'getForUser'>;
  runActivityService?: Pick<RunActivityService, 'getSummaryForRun'>;
  traceRoot?: string;
  s3TracesClient?: S3StorageService;
  traceIndexRepository?: TraceIndexRepository;
};

export type DashboardWindow = {
  days: number;
  since: Date;
  from: string;
  to: string;
};

export type DashboardTrajectory = 'improving' | 'stable' | 'regressing';
export type DashboardSecurityGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D+' | 'D' | 'D-' | 'F';
export type DashboardSecurityConfidence = 'low' | 'medium' | 'high';

export type FindingTrendPoint = {
  date: string;
  created: number;
  resolved: number;
  active: number;
};

export type DashboardSecurityPosture = {
  grade: DashboardSecurityGrade;
  numericScore: number;
  confidence: DashboardSecurityConfidence;
  methodology: 'academic_plus_minus';
  trend: DashboardTrajectory;
  validationCoverage: number | null;
  remediationVelocity: number | null;
  runsInWindow: number;
  rationale: string[];
  openFindings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
};

export const BACKLOG_RISK_STATES = ['potential', 'verifying', 'confirmed', 'not_reproduced'] as const;
export const INACTIVE_RISK_STATES = ['dismissed', 'resolved', 'accepted'] as const;
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const ACTIVE_RISK_STATE_SET = new Set<string>(BACKLOG_RISK_STATES);
export const INACTIVE_RISK_STATE_SET = new Set<string>(INACTIVE_RISK_STATES);

export const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const isActiveRiskState = (value: unknown): boolean =>
  typeof value === 'string' && ACTIVE_RISK_STATE_SET.has(value);

export const isInactiveRiskState = (value: unknown): boolean =>
  typeof value === 'string' && INACTIVE_RISK_STATE_SET.has(value);

export const isResolvedRiskState = (value: unknown): boolean => normalizeString(value) === 'resolved';

export const getStateTransitionActiveDelta = (fromState: unknown, toState: unknown): number => {
  const from = normalizeString(fromState);
  const to = normalizeString(toState);

  if (from && to) {
    return Number(isActiveRiskState(to)) - Number(isActiveRiskState(from));
  }

  if (!from && to) {
    if (isActiveRiskState(to)) return 1;
    if (isInactiveRiskState(to)) return -1;
  }

  return 0;
};

export const getStateTransitionResolvedDelta = (fromState: unknown, toState: unknown): number => {
  const from = normalizeString(fromState);
  const to = normalizeString(toState);

  if (from && to) {
    return Number(isResolvedRiskState(to)) - Number(isResolvedRiskState(from));
  }

  if (!from && to && isResolvedRiskState(to)) {
    return 1;
  }

  return 0;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toIsoString = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export const toDateKey = (value: Date): string => value.toISOString().slice(0, 10);

export const parseDays = (value: string | undefined, defaultDays: number = 30): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultDays;
  }
  return Math.min(Math.floor(parsed), 90);
};

export const parseLimit = (value: string | undefined, defaultLimit: number, maxLimit: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultLimit;
  }
  return Math.min(Math.floor(parsed), maxLimit);
};

export const buildWindow = (days: number): DashboardWindow => {
  const now = new Date();
  const since = new Date(now);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  return {
    days,
    since,
    from: since.toISOString(),
    to: now.toISOString(),
  };
};

export const normalizeRunDashboardStatus = (status: string): string => {
  switch (status) {
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return status;
    case 'credits_exhausted':
    case 'user_paused':
    case 'awaiting_user':
    case 'awaiting_approval':
      return 'paused';
    default:
      return normalizeString(status) || 'unknown';
  }
};

export const deriveTrajectory = ({
  backlogDelta,
}: {
  backlogDelta: number;
}): DashboardTrajectory => {
  if (backlogDelta < 0) {
    return 'improving';
  }

  if (backlogDelta > 0) {
    return 'regressing';
  }

  return 'stable';
};

export const roundTo = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const toAcademicSecurityGrade = (numericScore: number): DashboardSecurityGrade => {
  if (numericScore >= 97) return 'A+';
  if (numericScore >= 93) return 'A';
  if (numericScore >= 90) return 'A-';
  if (numericScore >= 87) return 'B+';
  if (numericScore >= 83) return 'B';
  if (numericScore >= 80) return 'B-';
  if (numericScore >= 77) return 'C+';
  if (numericScore >= 73) return 'C';
  if (numericScore >= 70) return 'C-';
  if (numericScore >= 67) return 'D+';
  if (numericScore >= 63) return 'D';
  if (numericScore >= 60) return 'D-';
  return 'F';
};

export const deriveSecurityConfidence = ({
  runsInWindow,
  validationCoverage,
  activeBacklog,
}: {
  runsInWindow: number;
  validationCoverage: number | null;
  activeBacklog: number;
}): DashboardSecurityConfidence => {
  if (runsInWindow >= 3 && (activeBacklog === 0 || (validationCoverage ?? 0) >= 0.6)) {
    return 'high';
  }

  if (runsInWindow >= 1) {
    return 'medium';
  }

  return 'low';
};

export const deriveRemediationScore = ({
  activeBacklog,
  createdInWindow,
  resolvedInWindow,
  remediationVelocity,
}: {
  activeBacklog: number;
  createdInWindow: number;
  resolvedInWindow: number;
  remediationVelocity: number | null;
}): number => {
  if (activeBacklog === 0 && createdInWindow === 0 && resolvedInWindow === 0) {
    return 10;
  }

  if (createdInWindow === 0 && resolvedInWindow === 0) {
    return activeBacklog === 0 ? 10 : 5;
  }

  if (remediationVelocity === null) {
    return activeBacklog === 0 ? 10 : 5;
  }

  if (remediationVelocity >= 1) return 10;
  if (remediationVelocity >= 0.75) return 8;
  if (remediationVelocity >= 0.5) return 6;
  if (remediationVelocity >= 0.25) return 4;
  if (remediationVelocity > 0) return 2;
  return 1;
};

export const deriveCadenceScore = (runsInWindow: number): number => {
  if (runsInWindow >= 6) return 10;
  if (runsInWindow >= 3) return 7;
  if (runsInWindow >= 1) return 4;
  return 0;
};

export const buildSecurityPosture = ({
  criticalOpen,
  highOpen,
  mediumOpen,
  lowOpen,
  infoOpen,
  activeBacklog,
  validatedOpenCount,
  remediationVelocity,
  createdInWindow,
  resolvedInWindow,
  runsInWindow,
  trend,
}: {
  criticalOpen: number;
  highOpen: number;
  mediumOpen: number;
  lowOpen: number;
  infoOpen: number;
  activeBacklog: number;
  validatedOpenCount: number;
  remediationVelocity: number | null;
  createdInWindow: number;
  resolvedInWindow: number;
  runsInWindow: number;
  trend: DashboardTrajectory;
}): DashboardSecurityPosture => {
  const validationCoverage = activeBacklog > 0 ? roundTo(validatedOpenCount / activeBacklog, 4) : null;
  const exposurePenalty = clamp(
    criticalOpen * 22 +
      highOpen * 10 +
      mediumOpen * 3 +
      lowOpen * 1 +
      infoOpen * 0.25 +
      Math.max(0, activeBacklog - 3) * 0.5,
    0,
    70,
  );
  const exposureScore = roundTo(70 - exposurePenalty, 2);
  const validationScore = activeBacklog > 0 ? roundTo((validationCoverage ?? 0) * 10, 2) : 10;
  const remediationScore = deriveRemediationScore({
    activeBacklog,
    createdInWindow,
    resolvedInWindow,
    remediationVelocity,
  });
  const cadenceScore = deriveCadenceScore(runsInWindow);
  const numericScore = clamp(Math.round(exposureScore + validationScore + remediationScore + cadenceScore), 0, 100);

  const rationale: string[] = [];
  if (criticalOpen > 0) {
    rationale.push(`${criticalOpen} unresolved critical finding${criticalOpen === 1 ? '' : 's'} are materially lowering posture.`);
  } else if (highOpen > 0) {
    rationale.push(`${highOpen} unresolved high-severity finding${highOpen === 1 ? '' : 's'} are keeping posture below the top bands.`);
  }

  if (activeBacklog > 0 && (validationCoverage ?? 0) < 0.5) {
    rationale.push(`Only ${Math.round((validationCoverage ?? 0) * 100)}% of active findings are validated.`);
  }

  if (runsInWindow === 0) {
    rationale.push('No testing runs were recorded in the last 30 days, so the grade has low evidence confidence.');
  } else if (remediationVelocity !== null && remediationVelocity < 0.5 && activeBacklog > 0) {
    rationale.push('Remediation is currently lagging behind new issue creation.');
  }

  if (rationale.length === 0) {
    rationale.push('No unresolved critical or high findings are depressing the current posture.');
    rationale.push('Recent testing and validation coverage support a strong grade.');
  }

  return {
    grade: toAcademicSecurityGrade(numericScore),
    numericScore,
    confidence: deriveSecurityConfidence({ runsInWindow, validationCoverage, activeBacklog }),
    methodology: 'academic_plus_minus',
    trend,
    validationCoverage,
    remediationVelocity,
    runsInWindow,
    rationale: rationale.slice(0, 3),
    openFindings: {
      critical: criticalOpen,
      high: highOpen,
      medium: mediumOpen,
      low: lowOpen,
      info: infoOpen,
    },
  };
};

export const createEmptyMix = <TKey extends string>(
  entries: Array<{ key: TKey; count: number }>,
): Array<{ key: TKey; count: number }> => entries.filter((entry) => entry.count > 0);

export const buildHeatmapSeries = (
  window: DashboardWindow,
  countsByDate: Map<string, number>,
): Array<{ date: string; count: number }> => {
  const series: Array<{ date: string; count: number }> = [];

  for (let offset = 0; offset < window.days; offset += 1) {
    const date = new Date(window.since);
    date.setUTCDate(window.since.getUTCDate() + offset);
    const dateKey = toDateKey(date);
    series.push({
      date: dateKey,
      count: countsByDate.get(dateKey) ?? 0,
    });
  }

  return series;
};

export const isSqlClause = (clause: SQL<unknown> | undefined): clause is SQL<unknown> => clause !== undefined;

export const createRunActivityService = (deps: DashboardRouteDeps): Pick<RunActivityService, 'getSummaryForRun'> => {
  const traceIndexRepository =
    deps.traceIndexRepository ?? (deps.s3TracesClient ? new TraceIndexRepository() : undefined);

  return new RunActivityService({
    timelineService: new TimelineService({
      traceRoot: deps.traceRoot ?? 'storage/object-store/traces',
      s3Client: deps.s3TracesClient,
      traceIndexRepository,
    }),
    sessionResolver: new SessionRepository(),
    phaseSource: new RunPhaseRepository(db),
    validationQueueSource: new ValidationQueueRepository(db),
    proxyCaptureSource: new WorkspaceProxyCaptureSource(db),
  });
};

export const buildActiveFindingClauses = (orgId: string, scopeId?: string, extraClauses: Array<SQL<unknown> | undefined> = []) =>
  [
    eq(findings.organizationId, orgId),
    scopeId ? eq(findings.scopeId, scopeId) : undefined,
    sql`${findings.state} <> 'dismissed'`,
    ...extraClauses,
  ].filter(isSqlClause);

export async function getFindingTrendSeries(orgId: string, scopeId: string | undefined, window: DashboardWindow) {
  const createdWhereClauses = buildActiveFindingClauses(orgId, scopeId, [sql`${findings.createdAt} >= ${window.since}`]);

  const findingsCreated = await db
    .select({
      date: sql<string>`to_char(${findings.createdAt}, 'YYYY-MM-DD')`,
      count: count(),
    })
    .from(findings)
    .where(and(...createdWhereClauses))
    .groupBy(sql`to_char(${findings.createdAt}, 'YYYY-MM-DD')`);

  const stateTransitionWhereClauses = [
    eq(findingEvents.organizationId, orgId),
    scopeId ? eq(findings.scopeId, scopeId) : undefined,
    sql`${findings.state} <> 'dismissed'`,
    sql`${findingEvents.createdAt} >= ${window.since}`,
    eq(findingEvents.type, 'state_changed'),
  ].filter(isSqlClause);

  const riskStateTransitions = await db
    .select({
      date: sql<string>`to_char(${findingEvents.createdAt}, 'YYYY-MM-DD')`,
      fromState: findingEvents.fromState,
      toState: findingEvents.toState,
      count: count(),
    })
    .from(findingEvents)
    .innerJoin(findings, eq(findings.id, findingEvents.findingId))
    .where(and(...stateTransitionWhereClauses))
    .groupBy(
      sql`to_char(${findingEvents.createdAt}, 'YYYY-MM-DD')`,
      findingEvents.fromState,
      findingEvents.toState,
    );

  const [currentActiveRow] = await db
    .select({ count: count() })
    .from(findings)
    .where(
      and(
        ...buildActiveFindingClauses(orgId, scopeId, [inArray(findings.state, ['potential', 'verifying', 'confirmed', 'not_reproduced'])]),
      ),
    );

  const [currentResolvedRow] = await db
    .select({ count: count() })
    .from(findings)
    .where(and(...buildActiveFindingClauses(orgId, scopeId, [eq(findings.state, 'resolved')])));

  const createdMap = new Map(findingsCreated.map((row) => [row.date, Number(row.count)]));
  const resolvedEventMap = new Map<string, number>();
  const activeDeltaMap = new Map<string, number>();
  const resolvedDeltaMap = new Map<string, number>();
  for (const row of riskStateTransitions) {
    const countValue = Number(row.count);
    if (!Number.isFinite(countValue) || countValue <= 0) {
      continue;
    }

    const singleTransitionDelta = getStateTransitionActiveDelta(row.fromState, row.toState);
    const statusDelta = singleTransitionDelta * countValue;
    if (statusDelta !== 0) {
      activeDeltaMap.set(row.date, (activeDeltaMap.get(row.date) ?? 0) + statusDelta);
    }

    const resolvedStateDelta = getStateTransitionResolvedDelta(row.fromState, row.toState) * countValue;
    if (resolvedStateDelta !== 0) {
      resolvedDeltaMap.set(row.date, (resolvedDeltaMap.get(row.date) ?? 0) + resolvedStateDelta);
    }

    if (singleTransitionDelta < 0 && normalizeString(row.toState) === 'resolved') {
      resolvedEventMap.set(row.date, (resolvedEventMap.get(row.date) ?? 0) + countValue);
    }
  }
  const createdInWindow = Array.from(createdMap.values()).reduce((sum, value) => sum + value, 0);
  const resolvedInWindow = Array.from(resolvedEventMap.values()).reduce((sum, value) => sum + value, 0);
  const activeBacklog = Number(currentActiveRow?.count ?? 0);
  const resolvedBacklog = Number(currentResolvedRow?.count ?? 0);

  const trendSeeds: Array<{ date: string; created: number }> = [];
  for (let offset = 0; offset < window.days; offset += 1) {
    const date = new Date(window.since);
    date.setUTCDate(window.since.getUTCDate() + offset);
    const dateKey = toDateKey(date);
    trendSeeds.push({
      date: dateKey,
      created: createdMap.get(dateKey) ?? 0,
    });
  }

  const trends = new Array<FindingTrendPoint>(trendSeeds.length);
  let runningActive = activeBacklog;
  let runningResolved = resolvedBacklog;

  for (let index = trendSeeds.length - 1; index >= 0; index -= 1) {
    const seed = trendSeeds[index];
    trends[index] = {
      date: seed.date,
      created: seed.created,
      resolved: runningResolved,
      active: runningActive,
    };
    const dailyActiveDelta = seed.created + (activeDeltaMap.get(seed.date) ?? 0);
    const dailyResolvedDelta = resolvedDeltaMap.get(seed.date) ?? 0;
    runningActive = Math.max(0, runningActive - dailyActiveDelta);
    runningResolved = Math.max(0, runningResolved - dailyResolvedDelta);
  }

  const startingActive = runningActive;

  return {
    trends,
    activeBacklog,
    createdInWindow,
    resolvedInWindow,
    backlogDelta: activeBacklog - startingActive,
  };
}


export type DashboardRouterContext = {
  getOrgId: (req: { user?: { id: string } }) => Promise<string>;
  runActivityService: Pick<RunActivityService, 'getSummaryForRun'>;
  complianceReadinessService: ComplianceReadinessService;
};
