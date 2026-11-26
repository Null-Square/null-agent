import { describe, expect, it } from 'vitest';

import {
  createRunnerSecurityOpsFlags,
  resolveRunnerSessionBinding,
  resolveRunnerWorkspaceKey,
} from '@/domains/security-ops/runners/runnerSession';

describe('runner session binding', () => {
  it('uses the SecurityOps run id as the private-runner workspace key', () => {
    const session = {
      id: 'phase-session-1',
      flags: {
        securityops: {
          executionTarget: 'scope_runner',
          runnerId: 'runner-1',
          runnerName: 'Private runner',
          runId: 'run-1',
        },
      },
    } as any;

    expect(resolveRunnerSessionBinding(session)).toMatchObject({
      executionTarget: 'scope_runner',
      runnerId: 'runner-1',
      runId: 'run-1',
    });
    expect(resolveRunnerWorkspaceKey(session)).toBe('run-run-1');
  });

  it('keeps non-run or cloud sessions session-scoped by omitting workspaceKey', () => {
    expect(
      resolveRunnerWorkspaceKey({
        id: 'session-1',
        flags: {
          securityops: {
            executionTarget: 'cloud',
            runId: 'run-1',
          },
        },
      } as any),
    ).toBeUndefined();

    expect(
      resolveRunnerWorkspaceKey({
        id: 'session-2',
        flags: {
          securityops: {
            executionTarget: 'scope_runner',
            runnerId: 'runner-1',
          },
        },
      } as any),
    ).toBeUndefined();
  });

  it('preserves Code Review as a first-class session discipline', () => {
    expect(
      createRunnerSecurityOpsFlags({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        workflowDiscipline: 'code_review',
      }),
    ).toMatchObject({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      workflowDiscipline: 'code_review',
    });
  });

  it('keeps platform cloud runner identity out of customer session flags', () => {
    const flags = createRunnerSecurityOpsFlags({
      organizationId: 'org-1',
      scopeId: 'scope-1',
      executionTarget: 'cloud',
      runnerId: 'platform-runner-1',
      runnerName: 'internal-hostname',
    });

    expect(flags).toMatchObject({ executionTarget: 'cloud' });
    expect(flags).not.toHaveProperty('runnerId');
    expect(flags).not.toHaveProperty('runnerName');
  });

  it('retains customer private runner identity for remote execution', () => {
    expect(
      createRunnerSecurityOpsFlags({
        organizationId: 'org-1',
        scopeId: 'scope-1',
        executionTarget: 'scope_runner',
        runnerId: 'private-runner-1',
        runnerName: 'Office runner',
      }),
    ).toMatchObject({
      runnerId: 'private-runner-1',
      runnerName: 'Office runner',
    });
  });
});
