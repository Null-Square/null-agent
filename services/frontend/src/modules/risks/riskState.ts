import type { RiskState } from '@/modules/security-ops/types';

/**
 * The one lifecycle, in the customer's words.
 *
 * The database has a single `state` now; these are its labels. Shared so the
 * Risks list and the Risk detail cannot drift into naming the same state two
 * different things, which is the drift the canonical work exists to end.
 */
export const RISK_STATE_LABELS: Record<RiskState, string> = {
  potential: 'Potential',
  verifying: 'Verifying',
  confirmed: 'Confirmed',
  not_reproduced: 'Not reproduced',
  dismissed: 'Dismissed',
  resolved: 'Resolved',
  accepted: 'Accepted',
};

export const riskStateLabel = (state: RiskState): string => RISK_STATE_LABELS[state] ?? state;
