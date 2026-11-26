import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { ToolContext } from '@/domains/agent-brain/application/tools/runtime/ToolContext';
import { ListRelevantSkills, LoadSkill } from '@/domains/agent-brain/adapters/tools/builtins/skills';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

describe('skill routing tools', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
  });

  afterEach(() => {
    store.shutdown();
  });

  const createContext = async (options: {
    activePhaseKey?: string;
    coordination?: Record<string, unknown>;
  } = {}): Promise<ToolContext> => {
    const session = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'test-model',
      promptProfile: 'phase-validation',
      flags: {
        securityops: {
          runId: 'run-1',
          activePhaseKey: options.activePhaseKey ?? 'validation',
          phaseAssignedSkillSlugs: ['broken-auth'],
        },
      },
      ...(options.coordination ? { coordination: options.coordination as any } : {}),
    });

    return {
      sessionId: session.id,
      turnNumber: 2,
      workspaceDir: session.workspaceDir!,
      sandbox: {} as any,
      sessionStore: store,
      streamBroker: {} as any,
      trace: { write: vi.fn().mockResolvedValue(undefined) } as any,
      approvals: { require: vi.fn().mockResolvedValue(undefined) },
      checkpoints: undefined,
      guards: {} as any,
      policies: {
        requireApproval: false,
        maxStdoutBytes: 65_536,
        timeoutMs: 120_000,
      },
      flags: session.flags ?? {},
      planRuntime: {} as any,
      abortSignal: new AbortController().signal,
    };
  };

  it('suggests phase-compatible skills from current state metadata', async () => {
    const ctx = await createContext({ activePhaseKey: 'validation' });

    const result = await ListRelevantSkills.run({
      phase: 'validation',
      target: 'https://api.example.com/users/123',
      riskFamily: 'idor',
      ntypes: ['http.endpoint', 'http.parameters'],
      technologies: ['rest'],
      limit: 5,
    }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      phaseKey: 'validation',
      rankingAdvisory: true,
    });
    expect((result.data as any).suggestions.map((entry: any) => entry.slug)).toContain('idor');
    expect(ctx.trace?.write).toHaveBeenCalledWith(
      ctx.sessionId,
      2,
      expect.objectContaining({
        event: 'skill.router_suggested',
      }),
    );
  });

  it('loads a compatible methodology into the workspace without returning the full file content', async () => {
    const ctx = await createContext({ activePhaseKey: 'validation' });

    const result = await LoadSkill.run({
      slug: 'idor',
      reason: 'Numeric user-owned API route needs object authorization methodology.',
    }, ctx);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      slug: 'idor',
      methodologyPath: '/workspace/.skills/idor/methodology.md',
      loadedSkillSlugs: ['idor'],
    });
    expect(JSON.stringify(result.data)).not.toContain('Mutation Algebra');
    await expect(readFile(join(ctx.workspaceDir, '.skills', 'idor', 'methodology.md'), 'utf8')).resolves.toContain('IDOR');
  });

  it('does not charge assigned methodologies against the worker on-demand load limit', async () => {
    const ctx = await createContext({
      activePhaseKey: 'validation',
      coordination: {
        role: 'worker',
        parentSessionId: 'parent-1',
        parentTaskId: 'task-1',
        workerType: 'validator_worker',
      },
    });

    await expect(LoadSkill.run({ slug: 'idor', reason: 'Need object authorization methodology.' }, ctx))
      .resolves.toMatchObject({ ok: true });
    await expect(LoadSkill.run({ slug: 'broken-auth', reason: 'Use the methodology assigned by the planner.' }, ctx))
      .resolves.toMatchObject({
        ok: true,
        data: {
          assigned: true,
          loadedSkillSlugs: ['idor'],
        },
      });
    expect(ctx.trace?.write).toHaveBeenCalledWith(
      ctx.sessionId,
      2,
      expect.objectContaining({ event: 'skill.assigned_method_accessed' }),
    );
    // A worker may load several methodologies now (a surface usually crosses
    // techniques); the ceiling is 6 on-demand loads, not 2.
    for (const slug of ['xss', 'ssrf', 'sql-injection', 'command-injection', 'csrf']) {
      await expect(LoadSkill.run({ slug, reason: `Need ${slug} methodology.` }, ctx))
        .resolves.toMatchObject({ ok: true });
    }

    const blocked = await LoadSkill.run({ slug: 'graphql', reason: 'Need one more methodology.' }, ctx);
    expect(blocked.ok).toBe(false);
    expect(blocked.data).toMatchObject({
      error: 'on-demand skill load limit reached (6)',
      loadedSkillSlugs: ['idor', 'xss', 'ssrf', 'sql-injection', 'command-injection', 'csrf'],
    });
  });
});
