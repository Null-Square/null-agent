import { inArray, type SQL } from 'drizzle-orm';

import { findings, type RiskState } from '@/db/schema';

export const OPEN_RISK_STATES = [
  'potential',
  'verifying',
  'confirmed',
  'not_reproduced',
] as const satisfies readonly RiskState[];

export const REPORTABLE_RISK_STATES = [
  'confirmed',
  'resolved',
  'accepted',
] as const satisfies readonly RiskState[];

export const activeRiskClause = (): SQL => inArray(findings.state, [...OPEN_RISK_STATES]);

export const reportableRiskClause = (): SQL =>
  inArray(findings.state, [...REPORTABLE_RISK_STATES]);

export const isOpenRiskState = (state: RiskState): boolean =>
  OPEN_RISK_STATES.includes(state as (typeof OPEN_RISK_STATES)[number]);

export const isReportableRiskState = (state: RiskState): boolean =>
  REPORTABLE_RISK_STATES.includes(state as (typeof REPORTABLE_RISK_STATES)[number]);

export const DIRECTLY_EDITABLE_RISK_STATES = [
  'confirmed',
  'accepted',
] as const satisfies readonly RiskState[];

export const isDirectRiskStateTransitionAllowed = (
  current: RiskState,
  next: RiskState,
): boolean =>
  current === next
  || (current === 'confirmed' && next === 'accepted')
  || (current === 'accepted' && next === 'confirmed');
