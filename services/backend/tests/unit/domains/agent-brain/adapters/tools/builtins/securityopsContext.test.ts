import { describe, expect, it } from 'vitest';

import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { resolveSecurityOpsToolContext } from '@/domains/agent-brain/adapters/tools/builtins/securityopsContext';

const makeContext = (input: {
  sessionScopeId?: unknown;
  sessionSecurityops?: unknown;
  flagsSecurityops?: unknown;
}): ToolContext =>
  ({
    sessionId: 'session-1',
    sessionStore: {
      get: () => ({
        ...(input.sessionScopeId !== undefined ? { scopeId: input.sessionScopeId } : {}),
        ...(input.sessionSecurityops === undefined ? {} : { flags: { securityops: input.sessionSecurityops } }),
      }),
    },
    flags: input.flagsSecurityops === undefined ? {} : { securityops: input.flagsSecurityops },
  } as unknown as ToolContext);

describe('resolveSecurityOpsToolContext', () => {
  it('prefers session.scopeId over flags.securityops.scopeId', () => {
    const context = resolveSecurityOpsToolContext(
      makeContext({
        sessionScopeId: 'scope-from-session',
        flagsSecurityops: {
          organizationId: 'org-1',
          scopeId: 'scope-from-flags',
          runId: 'run-1',
        },
      }),
    );

    expect(context).toEqual({
      organizationId: 'org-1',
      scopeId: 'scope-from-session',
      runId: 'run-1',
    });
  });

  it('falls back to flags.securityops.scopeId when session scope is missing', () => {
    const context = resolveSecurityOpsToolContext(
      makeContext({
        flagsSecurityops: {
          organizationId: 'org-2',
          scopeId: 'scope-from-flags',
          runId: 'run-2',
        },
      }),
    );

    expect(context).toEqual({
      organizationId: 'org-2',
      scopeId: 'scope-from-flags',
      runId: 'run-2',
    });
  });

  it('falls back to session securityops flags when context flags are missing runtime ids', () => {
    const context = resolveSecurityOpsToolContext(
      makeContext({
        sessionSecurityops: {
          organizationId: 'org-from-session',
          scopeId: 'scope-from-session-flags',
          runId: 'run-from-session',
          activePhaseKey: 'REPORTING',
          complianceReport: {
            framework: 'soc2',
            source: 'dashboard-readiness',
            sourceRunId: 'source-run-1',
          },
        },
      }),
    );

    expect(context).toEqual({
      organizationId: 'org-from-session',
      scopeId: 'scope-from-session-flags',
      runId: 'run-from-session',
      activePhaseKey: 'reporting',
      complianceReport: {
        framework: 'soc2',
        source: 'dashboard-readiness',
        sourceRunId: 'source-run-1',
      },
    });
  });

  it('prefers context activePhaseKey over session securityops flags', () => {
    const context = resolveSecurityOpsToolContext(
      makeContext({
        sessionSecurityops: {
          organizationId: 'org-from-session',
          scopeId: 'scope-from-session',
          runId: 'run-from-session',
          activePhaseKey: 'validation',
        },
        flagsSecurityops: {
          organizationId: 'org-from-context',
          scopeId: 'scope-from-context',
          runId: 'run-from-context',
          activePhaseKey: ' Reporting ',
        },
      }),
    );

    expect(context).toEqual({
      organizationId: 'org-from-context',
      scopeId: 'scope-from-context',
      runId: 'run-from-context',
      activePhaseKey: 'reporting',
    });
  });

  it('derives assessment reporting context from workflow discipline, not assigned skill slugs', () => {
    const compliance = resolveSecurityOpsToolContext(
      makeContext({
        sessionSecurityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-1',
          workflowDiscipline: 'compliance',
          phaseAssignedSkillSlugs: ['security-reporting'],
          complianceAssessment: { framework: 'iso27001' },
        },
      }),
    );
    const pentest = resolveSecurityOpsToolContext(
      makeContext({
        sessionSecurityops: {
          organizationId: 'org-1',
          scopeId: 'scope-1',
          runId: 'run-2',
          workflowDiscipline: 'pentest',
          phaseAssignedSkillSlugs: ['compliance-reporting'],
          complianceAssessment: { framework: 'soc2' },
        },
      }),
    );

    expect(compliance).toMatchObject({
      workflowDiscipline: 'compliance',
      complianceAssessment: { framework: 'iso27001' },
      complianceReport: { framework: 'iso27001', source: 'assessment-run' },
    });
    expect(pentest).toMatchObject({ workflowDiscipline: 'pentest' });
    expect(pentest.complianceReport).toBeUndefined();
  });

  it('drops non-string values from flags and session scope', () => {
    const context = resolveSecurityOpsToolContext(
      makeContext({
        sessionScopeId: 123,
        flagsSecurityops: {
          organizationId: ['org-array'],
          scopeId: 456,
          runId: { id: 'run-object' },
        },
      }),
    );

    expect(context).toEqual({
      organizationId: undefined,
      scopeId: undefined,
      runId: undefined,
    });
  });

  it('returns empty context when securityops flags are missing or invalid', () => {
    const missingFlags = resolveSecurityOpsToolContext(makeContext({}));
    const invalidFlags = resolveSecurityOpsToolContext(
      makeContext({
        flagsSecurityops: 'not-an-object',
      }),
    );

    expect(missingFlags).toEqual({
      organizationId: undefined,
      scopeId: undefined,
      runId: undefined,
    });
    expect(invalidFlags).toEqual({
      organizationId: undefined,
      scopeId: undefined,
      runId: undefined,
    });
  });
});

