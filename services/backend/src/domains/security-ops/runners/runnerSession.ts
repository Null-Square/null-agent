import type { SessionFlags, SessionState } from '@/domains/agent-brain/domain/types';
import type { RunWorkflowDiscipline } from '@/db/schema';
import {
  DEFAULT_EXECUTION_TARGET,
  normalizeExecutionTarget,
  type ExecutionTarget,
} from '@/domains/security-ops/runs/executionTargets';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export type RunnerSessionBinding = {
  executionTarget: ExecutionTarget;
  runnerId: string | null;
  runnerName: string | null;
  runId: string | null;
};

const readBinding = (value: unknown): RunnerSessionBinding => {
  const securityops = isRecord(value) ? value : null;
  const executionTarget = normalizeExecutionTarget(securityops?.executionTarget);
  const runnerId =
    typeof securityops?.runnerId === 'string' && securityops.runnerId.trim().length > 0
      ? securityops.runnerId.trim()
      : null;
  const runnerName =
    typeof securityops?.runnerName === 'string' && securityops.runnerName.trim().length > 0
      ? securityops.runnerName.trim()
      : null;
  const runId =
    typeof securityops?.runId === 'string' && securityops.runId.trim().length > 0
      ? securityops.runId.trim()
      : null;

  return { executionTarget, runnerId, runnerName, runId };
};

export const resolveRunnerSessionBindingFromFlags = (
  flags: SessionFlags | Record<string, unknown> | null | undefined,
): RunnerSessionBinding => {
  const root = isRecord(flags) ? flags : null;
  return readBinding(root?.securityops);
};

export const resolveRunnerSessionBinding = (session: Pick<SessionState, 'flags'>): RunnerSessionBinding =>
  resolveRunnerSessionBindingFromFlags(session.flags);

export const isScopeRunnerBinding = (binding: RunnerSessionBinding): boolean =>
  binding.executionTarget === 'scope_runner' && typeof binding.runnerId === 'string' && binding.runnerId.length > 0;

const normalizeRunnerWorkspaceKeyPart = (value: string): string =>
  value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

export const resolveRunnerWorkspaceKey = (session: Pick<SessionState, 'id' | 'flags'>): string | undefined => {
  const binding = resolveRunnerSessionBinding(session);
  if (!isScopeRunnerBinding(binding) || !binding.runId) {
    return undefined;
  }
  const normalizedRunId = normalizeRunnerWorkspaceKeyPart(binding.runId);
  return normalizedRunId ? `run-${normalizedRunId}` : undefined;
};

export const createRunnerSecurityOpsFlags = (params: {
  organizationId: string;
  scopeId: string;
  runId?: string;
  workflowDiscipline?: RunWorkflowDiscipline;
  executionTarget?: ExecutionTarget | null;
  runnerId?: string | null;
  runnerName?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> => {
  const executionTarget = params.executionTarget ?? DEFAULT_EXECUTION_TARGET;
  const exposesCustomerRunner = executionTarget === 'scope_runner';
  return {
    organizationId: params.organizationId,
    scopeId: params.scopeId,
    ...(params.runId ? { runId: params.runId } : {}),
    workflowDiscipline: params.workflowDiscipline ?? 'pentest',
    executionTarget,
    ...(exposesCustomerRunner && params.runnerId ? { runnerId: params.runnerId } : {}),
    ...(exposesCustomerRunner && params.runnerName ? { runnerName: params.runnerName } : {}),
    ...(params.extra ?? {}),
  };
};
