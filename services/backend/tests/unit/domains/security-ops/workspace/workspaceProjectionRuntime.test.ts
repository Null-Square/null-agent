import { describe, expect, it, vi } from 'vitest';

import {
  attachProjectionWarning,
  flushWorkspaceProjectionForSession,
} from '@/domains/security-ops/workspace/workspaceProjectionRuntime';

const makeHarness = () => {
  const session = {
    id: 'session-1',
    workspaceDir: 'C:/tmp/null-workspace',
    scopeId: 'scope-1',
    turn: 7,
    flags: {
      securityops: {
        organizationId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        activePhaseKey: 'recon',
        phaseAssignedSkillSlugs: ['http-analysis'],
      },
    },
  } as any;

  const sessionStore = {
    get: vi.fn(() => session),
    mergeFlagNamespaceAsync: vi.fn(async (_sessionId: string, namespace: string, values: Record<string, unknown>) => {
      session.flags[namespace] = {
        ...(session.flags[namespace] ?? {}),
        ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
      };
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) {
          delete session.flags[namespace][key];
        }
      }
      return true;
    }),
  } as any;

  const sandbox = {
    writeFile: vi.fn(),
    exec: vi.fn(),
  } as any;

  const ctx = {
    sessionId: session.id,
    turnNumber: 7,
    sessionStore,
    sandbox,
    trace: { write: vi.fn().mockResolvedValue(undefined) },
  } as any;

  return { session, sessionStore, sandbox, ctx };
};

describe('workspace projection runtime batching', () => {
  it('coalesces dirty scopes and flushes once at the boundary', async () => {
    const { session, sessionStore, sandbox, ctx } = makeHarness();
    const service = {
      projectRunWorkspace: vi.fn().mockResolvedValue({
        success: true,
        written: ['recon/endpoints.json', 'journal/coverage.json', 'journal/model.md'],
        skipped: [],
        warnings: [],
      }),
    } as any;

    await attachProjectionWarning({
      ctx,
      data: { success: true },
      reason: 'report_note:http.endpoint',
      scopes: ['recon', 'model'],
    });
    await attachProjectionWarning({
      ctx,
      data: { success: true },
      reason: 'report_note:scan.coverage',
      scopes: ['coverage', 'model'],
    });

    const result = await flushWorkspaceProjectionForSession({
      sessionStore,
      sandbox,
      trace: ctx.trace,
      sessionId: session.id,
      reason: 'turn_boundary',
      forceModel: true,
      service,
    });

    expect(result).toMatchObject({
      flushed: true,
      written: 3,
      writtenPaths: ['recon/endpoints.json', 'journal/coverage.json', 'journal/model.md'],
      requestedScopes: [],
      forceModel: true,
      dirtyCount: 2,
    });
    expect(service.projectRunWorkspace).toHaveBeenCalledTimes(1);
    expect(service.projectRunWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        scopeId: 'scope-1',
        runId: 'run-1',
        reason: 'turn_boundary',
        scopes: expect.arrayContaining(['recon', 'coverage', 'model']),
      }),
    );
    expect(ctx.trace.write).toHaveBeenCalledWith(
      session.id,
      7,
      expect.objectContaining({
        event: 'workspace_projection.flushed',
        payload: expect.objectContaining({
          reason: 'turn_boundary',
          requestedScopes: [],
          flushedScopes: expect.arrayContaining(['recon', 'coverage', 'model']),
          forceModel: true,
          dirtyCount: 2,
          dirtyReasons: expect.arrayContaining(['report_note:http.endpoint', 'report_note:scan.coverage']),
          writtenPaths: ['recon/endpoints.json', 'journal/coverage.json', 'journal/model.md'],
        }),
      }),
    );
    expect(session.flags.securityops.workspaceProjectionDirty).toBeUndefined();
  });

  it('keeps dirty scopes when the boundary flush fails', async () => {
    const { session, sessionStore, sandbox, ctx } = makeHarness();
    const service = {
      projectRunWorkspace: vi.fn().mockRejectedValue(new Error('runner offline')),
    } as any;

    await attachProjectionWarning({
      ctx,
      data: { success: true },
      reason: 'report_finding',
      scopes: ['findings', 'evidence', 'model'],
    });

    const result = await flushWorkspaceProjectionForSession({
      sessionStore,
      sandbox,
      sessionId: session.id,
      reason: 'turn_boundary',
      forceModel: true,
      service,
    });

    expect(result.warning).toContain('runner offline');
    expect(session.flags.securityops.workspaceProjectionDirty.scopes).toEqual(
      expect.arrayContaining(['findings', 'evidence', 'model']),
    );
  });

  it('accepts compliance as a dirty workspace projection scope', async () => {
    const { session, ctx } = makeHarness();

    const data = await attachProjectionWarning({
      ctx,
      data: { requestId: 'request-1', created: true },
      reason: 'record_control_request',
      scopes: ['compliance', 'model'],
    });

    expect(data).toEqual({ requestId: 'request-1', created: true });
    expect(session.flags.securityops.workspaceProjectionDirty).toMatchObject({
      scopes: expect.arrayContaining(['compliance', 'model']),
      reasons: ['record_control_request'],
      dirtyCount: 1,
    });
    expect(ctx.trace.write).toHaveBeenCalledWith(
      session.id,
      7,
      expect.objectContaining({
        event: 'workspace_projection.dirty_marked',
        payload: expect.objectContaining({
          scopes: ['compliance', 'model'],
        }),
      }),
    );
  });
});
