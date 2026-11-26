import { describe, expect, it, vi } from 'vitest';

import { createToolEntitlementGuard } from '@/domains/agent-brain/adapters/tools/ToolEntitlementGuard';
import type { PreToolUseHookContext } from '@/domains/agent-brain/application/tools';

const makeContext = (
  toolName: string,
  args: Record<string, unknown> = {},
  flags: Record<string, unknown> = {},
): PreToolUseHookContext => ({
  sessionId: 'session-1',
  session: ({
    id: 'session-1',
    userId: 'user-1',
    messages: [],
    plan: [],
    memory: {
      discoveredFacts: [],
      attemptedTechniques: {},
      failedApproaches: [],
      testedEndpoints: [],
    },
    flags: {
      securityops: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        ...flags,
      },
    },
    workspaceDir: '/tmp/session-1',
  } as never),
  toolName,
  args,
  descriptor: {
    toolName,
    category: 'securityops',
    actions: [],
    risks: [],
    paths: [],
    hosts: [],
    args,
  },
});

const makeGuard = () => {
  const accessControl = {
    enforceAutomationCreation: vi.fn().mockResolvedValue(undefined),
    enforcePrivateRunnerAccess: vi.fn().mockResolvedValue(undefined),
    enforceModelCategoryAccess: vi.fn().mockResolvedValue(undefined),
    enforceComplianceAccess: vi.fn().mockResolvedValue(undefined),
    enforceGitHubIntegrationAccess: vi.fn().mockResolvedValue(undefined),
    enforceCodeReviewAccess: vi.fn().mockResolvedValue(undefined),
    enforceRunObservabilityAccess: vi.fn().mockResolvedValue(undefined),
  };
  const automationService = {
    countAutomations: vi.fn().mockResolvedValue(2),
  };
  const modelConfigPort = {
    getModel: vi.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      modelName: 'test-model',
      provider: 'openai',
      isActive: true,
      selectionCategory: 'high',
    }),
    listModelsForCategory: vi.fn().mockResolvedValue([{
      id: '22222222-2222-4222-8222-222222222222',
      modelName: 'category-model',
      provider: 'openai',
      isActive: true,
      selectionCategory: 'high',
    }]),
  };

  return {
    accessControl,
    automationService,
    modelConfigPort,
    guard: createToolEntitlementGuard({
      accessControl,
      automationService,
      modelConfigPort,
    }),
  };
};

describe('ToolEntitlementGuard', () => {
  it('blocks a compliance tool when the compliance gate denies access', async () => {
    const { guard, accessControl } = makeGuard();
    accessControl.enforceComplianceAccess.mockRejectedValueOnce(new Error('Compliance is not available on your plan'));

    const result = await guard.onPreToolUse?.(makeContext('query_compliance_readiness'));

    expect(result).toEqual({
      continue: false,
      reason: expect.stringContaining('Compliance is not available on your plan'),
    });
  });

  it('enforces automation, private runner, and model-category gates for automation creation', async () => {
    const { guard, accessControl, automationService, modelConfigPort } = makeGuard();

    const result = await guard.onPreToolUse?.(makeContext('create_scope_automation', {
      executionTarget: 'scope_runner',
      modelCategory: 'high',
    }));

    expect(result).toBeUndefined();
    expect(automationService.countAutomations).toHaveBeenCalledWith('org-1');
    expect(accessControl.enforceAutomationCreation).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      existingAutomationCount: 2,
    });
    expect(accessControl.enforcePrivateRunnerAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(modelConfigPort.listModelsForCategory).toHaveBeenCalledWith('high');
    expect(accessControl.enforceModelCategoryAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
      requestedModelCategory: 'high',
    });
  });

  it('enforces compliance for a compliance-scoped session even on generic tools', async () => {
    const { guard, accessControl } = makeGuard();

    const result = await guard.onPreToolUse?.(makeContext('report_note', {}, {
      workflowDiscipline: 'compliance',
      complianceAssessment: { framework: 'soc2' },
    }));

    expect(result).toBeUndefined();
    expect(accessControl.enforceComplianceAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('enforces the Code Review product gate for a Code Review session', async () => {
    const { guard, accessControl } = makeGuard();

    const result = await guard.onPreToolUse?.(makeContext('file_read', {}, {
      workflowDiscipline: 'code_review',
    }));

    expect(result).toBeUndefined();
    expect(accessControl.enforceCodeReviewAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
    expect(accessControl.enforceComplianceAccess).not.toHaveBeenCalled();
  });

  it('keeps the organization GitHub integration entitlement gate unchanged', async () => {
    const { guard, accessControl } = makeGuard();

    await guard.onPreToolUse?.(makeContext('read_connected_repository_file'));

    expect(accessControl.enforceGitHubIntegrationAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('requires both Code Review and GitHub integration access for dedicated repository reads', async () => {
    for (const toolName of [
      'list_code_review_repository_files',
      'search_code_review_repository',
      'query_code_review_memory',
      'record_code_review_memory',
    ]) {
      const { guard, accessControl } = makeGuard();

      const result = await guard.onPreToolUse?.(makeContext(
        toolName,
        {},
        { workflowDiscipline: 'code_review' },
      ));

      expect(result).toBeUndefined();
      expect(accessControl.enforceCodeReviewAccess).toHaveBeenCalled();
      expect(accessControl.enforceGitHubIntegrationAccess).toHaveBeenCalled();
    }
  });

  it('delegates entitlements to the explicit Research Lab host adapter', async () => {
    const { guard, accessControl } = makeGuard();
    accessControl.enforceGitHubIntegrationAccess.mockRejectedValueOnce(
      new Error('Organization plan gate should not run'),
    );

    const result = await guard.onPreToolUse?.(makeContext(
      'read_connected_repository_file',
      {},
      { runHost: 'research_lab', runId: 'hosted-run-1' },
    ));

    expect(result).toBeUndefined();
    expect(accessControl.enforceGitHubIntegrationAccess).not.toHaveBeenCalled();
  });
});
