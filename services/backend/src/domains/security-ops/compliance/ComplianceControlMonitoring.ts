import type { ComplianceFrameworkKey, ControlDefinition } from './frameworks';

export type ComplianceControlMonitoringState = 'monitored' | 'excluded';
export type ComplianceControlMonitoringSource = 'default' | 'explicit';

/** System reason applied when a catalog control is outside the selected scope
 *  rather than excluded by an explicit user decision. */
export const SYSTEM_EXCLUSION_REASON =
  'Not in the selected scope for this framework.';

export interface ComplianceControlMonitoringView {
  state: ComplianceControlMonitoringState;
  source: ComplianceControlMonitoringSource;
  exclusionReason: string | null;
  updatedAt: string | null;
}

export interface ComplianceControlAssignmentView {
  assignedToUserId: string | null;
  assignedByUserId: string | null;
  assignedAt: string | null;
}

export const defaultMonitoringStateForControl = (
  definition: Pick<ControlDefinition, 'supportLevel'>,
  _frameworkKey?: ComplianceFrameworkKey,
): ComplianceControlMonitoringState =>
  definition.supportLevel === 'out_of_selected_scope'
    ? 'excluded'
    : 'monitored';
