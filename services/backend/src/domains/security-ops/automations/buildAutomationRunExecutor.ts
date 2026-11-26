import type { ScopeService } from '@/domains/security-ops/scopes/ScopeService';
import {
  DEFAULT_PLANNER_TOOL_POLICY,
  type StartRunService,
} from '@/domains/security-ops/runs/StartRunService';
import type { RunService } from '@/domains/security-ops/runs/RunService';
import type { AccessControlService } from '@/domains/platform/subscriptions/accessControlService';
import { AppError, ERROR_CODES } from '@/shared/errors';
import type { AutomationRunExecutor } from './AutomationService';
import { schedulingClassForPlan } from '@/domains/security-ops/runs/scheduling/CloudRunSchedulingConfig';

type RunExecutorDeps = {
  startRunService: StartRunService;
  scopeService: ScopeService;
  runService: Pick<RunService, 'countPlanConcurrentRuns'>;
  accessControl: Pick<AccessControlService, 'enforceAutomationFeature' | 'enforceRunCreation' | 'enforceComplianceAccess'>;
  allowExecution?: boolean;
};

export const createAutomationRunExecutor = (deps: RunExecutorDeps): AutomationRunExecutor =>
  async ({
    orgId,
    userId,
    scopeId,
    goal,
    modelId,
    modelCategory,
    workflowDiscipline,
    complianceFrameworkKey,
    executionTarget,
    trigger,
    vars,
    executionSelection,
  }) => {
    if (deps.allowExecution === false) {
      throw new AppError(ERROR_CODES.INTERNAL_CONFIGURATION, 'Run execution is not available on this node');
    }

    const sourceScopeOverride =
      typeof vars?.__source_scope_id === 'string' ? vars.__source_scope_id.trim() : '';
    const effectiveScopeId = sourceScopeOverride || scopeId;
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) {
      throw new AppError(ERROR_CODES.VALIDATION_MISSING_REQUIRED, 'goal is required');
    }

    await deps.accessControl.enforceAutomationFeature({ userId, organizationId: orgId });
    if (workflowDiscipline === 'compliance') {
      await deps.accessControl.enforceComplianceAccess({ userId, organizationId: orgId });
    }
    const activeRunCount = await deps.runService.countPlanConcurrentRuns(orgId);
    const subscription = await deps.accessControl.enforceRunCreation({
      userId,
      organizationId: orgId,
      activeRunCount,
    requestedModelCategory: modelCategory ?? null,
      deferConcurrencyToAdmission: deps.startRunService.usesQueuedCloudAdmission(executionTarget),
    });

    await deps.scopeService.getById(orgId, effectiveScopeId);
    // Automation triggers (scheduled / event / webhook) always run unattended,
    // so they auto-approve the planner output. Safe Mode applies to manual runs
    // only; see runs.router.ts for the manual-run derivation.
    const autoApproveOnPlanning = trigger !== 'manual';

    const runVars: Record<string, unknown> = { ...(vars ?? {}) };
    delete runVars.__source_scope_id;

    const startResult = await deps.startRunService.startPlannerRun({
      orgId,
      userId,
      scopeId: effectiveScopeId,
      goal: normalizedGoal,
      modelId: modelId ?? undefined,
      modelCategory: modelCategory ?? undefined,
      executionTarget,
      trigger,
      vars: runVars,
      toolPolicy: DEFAULT_PLANNER_TOOL_POLICY,
      idempotency: 'disabled',
      workflowDiscipline,
      complianceFrameworkKey,
      securityOpsFlags: {
        automationTriggered: true,
      },
      autoApproveOnPlanning,
      maxConcurrentRuns: subscription.plan.limits?.maxConcurrentRuns ?? null,
      schedulingClass: schedulingClassForPlan(subscription.plan.slug),
      executionSelection,
    });

    return {
      run: {
        id: startResult.run.id,
        displayId: startResult.run.displayId,
        status: startResult.run.status,
        scopeId: startResult.run.scopeId,
        goal: startResult.run.goal ?? normalizedGoal,
        createdAt: startResult.run.createdAt,
      },
      sessionId: startResult.sessionId,
    };
  };
