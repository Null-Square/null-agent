import type { RunPhaseStatus } from './PhaseProfileRegistry';

const PHASE_LABELS: Record<string, string> = {
  recon: 'Recon',
  enumeration: 'Enumeration',
  validation: 'Validation',
  exploitation: 'Exploitation',
  evidence: 'Evidence',
  control_assessment: 'Control Assessment',
  reporting: 'Reporting',
};

const CANONICAL_PHASES = new Set(Object.keys(PHASE_LABELS));

const TERMINAL_PHASE_STATUSES = new Set<RunPhaseStatus>([
  'completed',
  'blocked',
  'failed',
  'timed_out',
  'aborted',
]);

export type ProjectedRunPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type RunPhaseProjectionRow = {
  id: string;
  ordinal: number;
  phaseKey: string;
  status: string;
  sessionId?: string | null;
  startedAt?: Date | string | number | null;
  completedAt?: Date | string | number | null;
  lastError?: string | null;
};

export type ProjectedRunPhase = {
  id: string;
  phase: string;
  label: string;
  ordinal: number;
  status: ProjectedRunPhaseStatus;
  rawStatus: string;
  sessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  reason: string | null;
};

const toPhaseDisplayStatus = (status: RunPhaseStatus): ProjectedRunPhaseStatus => {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'active':
    case 'handoff_submitted':
      return 'running';
    case 'completed':
      return 'completed';
    case 'blocked':
    case 'failed':
    case 'timed_out':
    case 'aborted':
      return 'failed';
    default:
      return 'pending';
  }
};

const toIso = (value: Date | string | number | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function projectRunPhaseRows(
  rows: readonly RunPhaseProjectionRow[],
  runStatus: string,
): ProjectedRunPhase[] {
  const completedRun = runStatus === 'completed';
  const terminalRunStatus = runStatus === 'cancelled' || runStatus === 'failed' ? runStatus : null;

  return rows
    .filter((row) => CANONICAL_PHASES.has(row.phaseKey))
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((row) => {
      const storedStatus = row.status as RunPhaseStatus;
      let effectiveStatus = storedStatus;
      if (completedRun && !TERMINAL_PHASE_STATUSES.has(storedStatus)) {
        effectiveStatus = 'completed';
      } else if (terminalRunStatus && !TERMINAL_PHASE_STATUSES.has(storedStatus)) {
        effectiveStatus = terminalRunStatus === 'cancelled' ? 'aborted' : 'failed';
      }

      const startedAt = toIso(row.startedAt);
      const completedAt = toIso(row.completedAt);
      const durationMs =
        startedAt && completedAt
          ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
          : null;

      const displayStatus =
        row.phaseKey === 'exploitation' &&
        typeof row.lastError === 'string' &&
        row.lastError.startsWith('controlled_exploitation_skipped:')
          ? 'skipped'
          : toPhaseDisplayStatus(effectiveStatus);
      const reason =
        displayStatus === 'skipped' && typeof row.lastError === 'string'
          ? row.lastError.replace(/^controlled_exploitation_skipped:/u, '')
          : row.lastError ?? null;

      return {
        id: row.id,
        phase: row.phaseKey,
        label: PHASE_LABELS[row.phaseKey] ?? row.phaseKey,
        ordinal: row.ordinal,
        status: displayStatus,
        rawStatus: effectiveStatus,
        sessionId: row.sessionId ?? null,
        startedAt,
        completedAt,
        durationMs,
        reason,
      };
    });
}
