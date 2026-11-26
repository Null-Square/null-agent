import { describe, expect, it, vi } from 'vitest';

import { createAutomationRunExecutor } from '@/domains/security-ops/automations/buildAutomationRunExecutor';

const makeBaseDeps = (overrides: { scopeService?: object; startRunService?: object } = {}) => {
  const runService = { countPlanConcurrentRuns: vi.fn().mockResolvedValue(0) };
  const accessControl = {
    enforceAutomationFeature: vi.fn().mockResolvedValue(undefined),
    enforceComplianceAccess: vi.fn().mockResolvedValue(undefined),
    enforceRunCreation: vi.fn().mockResolvedValue({
      plan: { slug: 'control', limits: { maxConcurrentRuns: 2 } },
    }),
  };
  return {
    runService,
    accessControl,
    ...overrides,
    startRunService: {
      usesQueuedCloudAdmission: vi.fn().mockReturnValue(false),
      ...(overrides.startRunService ?? {}),
    },
  };
};

describe('createAutomationRunExecutor', () => {
  it('uses source scope override and auto-approves unattended triggers regardless of safeMode', async () => {
    const scopeService = {
      getById: vi.fn().mockResolvedValue({
        scope: {
          id: 'scope-event',
          // Safe Mode applies to manual runs only; automations always
          // auto-approve. This scope is explicitly safeMode: true to confirm
          // the executor ignores it for non-manual triggers.
          safeMode: true,
        },
      }),
    };

    const startRunService = {
      startPlannerRun: vi.fn().mockResolvedValue({
        run: {
          id: 'run-1',
          displayId: 1,
          status: 'running',
          scopeId: 'scope-event',
          goal: 'Assess scope',
          createdAt: new Date(),
        },
        sessionId: 'session-1',
      }),
    };

    const execute = createAutomationRunExecutor({
      ...makeBaseDeps({ scopeService, startRunService }),
      allowExecution: true,
    } as never);

    await execute({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-default',
      goal: 'Assess scope',
      modelId: 'model-1',
      trigger: 'event',
      vars: {
        __source_scope_id: 'scope-event',
        customFlag: true,
      },
    });

    expect(scopeService.getById).toHaveBeenCalledWith('org-1', 'scope-event');
    expect(startRunService.startPlannerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: 'scope-event',
        goal: 'Assess scope',
        modelId: 'model-1',
        trigger: 'event',
        autoApproveOnPlanning: true,
        vars: expect.not.objectContaining({
          __source_scope_id: expect.anything(),
        }),
      }),
    );
  });

  it('does not auto-approve manual automation runs', async () => {
    const scopeService = {
      getById: vi.fn().mockResolvedValue({
        scope: {
          id: 'scope-manual',
          safeMode: false,
        },
      }),
    };

    const startRunService = {
      startPlannerRun: vi.fn().mockResolvedValue({
        run: {
          id: 'run-2',
          displayId: 2,
          status: 'awaiting_approval',
          scopeId: 'scope-manual',
          goal: 'Manual run goal',
          createdAt: new Date(),
        },
        sessionId: 'session-2',
      }),
    };

    const execute = createAutomationRunExecutor({
      ...makeBaseDeps({ scopeService, startRunService }),
      allowExecution: true,
    } as never);

    const executionSelection = {
      routeId: 'codex-subscription',
      catalogueRevision: 'catalogue-1',
      modelId: 'gpt-5.6-sol',
      controls: { effort: 'high' },
    };
    await execute({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-manual',
      goal: 'Manual run goal',
      modelId: 'model-2',
      trigger: 'manual',
      vars: {},
      executionSelection,
    });

    expect(startRunService.startPlannerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'model-2',
        autoApproveOnPlanning: false,
        executionSelection,
      }),
    );
  });

  it('forwards compliance workflow metadata into started runs', async () => {
    const scopeService = {
      getById: vi.fn().mockResolvedValue({
        scope: {
          id: 'scope-compliance',
          safeMode: false,
        },
      }),
    };

    const startRunService = {
      startPlannerRun: vi.fn().mockResolvedValue({
        run: {
          id: 'run-3',
          displayId: 3,
          status: 'running',
          scopeId: 'scope-compliance',
          goal: 'Assess SOC 2 access controls',
          createdAt: new Date(),
        },
        sessionId: 'session-3',
      }),
    };

    const deps = makeBaseDeps({ scopeService, startRunService });
    const execute = createAutomationRunExecutor({
      ...deps,
      allowExecution: true,
    } as never);

    await execute({
      orgId: 'org-1',
      userId: 'user-1',
      scopeId: 'scope-compliance',
      goal: 'Assess SOC 2 access controls',
      modelId: 'model-3',
      workflowDiscipline: 'compliance',
      complianceFrameworkKey: 'soc2',
      trigger: 'scheduled',
      vars: {},
    });

    expect(deps.accessControl.enforceComplianceAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(startRunService.startPlannerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowDiscipline: 'compliance',
        complianceFrameworkKey: 'soc2',
      }),
    );
  });
});
