export const REPORTING_CLOSEOUT_OUTCOMES = [
  'no_findings_after_coverage',
  'interim_blocked',
  'needs_operator_input',
] as const;

export type ReportingCloseoutOutcome = typeof REPORTING_CLOSEOUT_OUTCOMES[number];

export const normalizeReportingCloseoutOutcome = (
  value: unknown,
): ReportingCloseoutOutcome | undefined =>
  typeof value === 'string' && REPORTING_CLOSEOUT_OUTCOMES.includes(value as ReportingCloseoutOutcome)
    ? value as ReportingCloseoutOutcome
    : undefined;

export const reportingCloseoutRequiresInterim = (
  outcome: ReportingCloseoutOutcome | undefined,
): boolean => outcome === 'interim_blocked' || outcome === 'needs_operator_input';

export const mergeRunFindingIds = (
  explicitFindingIds: readonly (string | null | undefined)[],
  discoveredFindingIds: readonly (string | null | undefined)[],
): string[] => Array.from(
  new Set(
    [...explicitFindingIds, ...discoveredFindingIds]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0),
  ),
);
