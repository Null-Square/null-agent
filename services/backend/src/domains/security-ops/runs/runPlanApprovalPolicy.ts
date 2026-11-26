import type { RunRow } from '@/db/schema';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Resolve the approval decision captured when the Run was created.
 *
 * New planner Runs persist this decision in launch_payload. For older Runs,
 * unattended triggers continue automatically while manual Runs fail closed and
 * still require approval.
 */
export const shouldAutoApproveInitialPlan = (
  run: Pick<RunRow, 'trigger' | 'launchPayload'>,
): boolean => {
  const payload = run.launchPayload;
  if (isRecord(payload) && payload.kind === 'planner' && isRecord(payload.params)) {
    const configured = payload.params.autoApproveOnPlanning;
    if (typeof configured === 'boolean') {
      return configured;
    }
  }

  return run.trigger !== 'manual';
};
