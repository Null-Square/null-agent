import { vi, describe, it, expect } from 'vitest';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { PlanItem, SessionState } from '@/domains/agent-brain/domain/types';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import { createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const createStore = (overrides: Partial<any> = {}) => {
  const sessionRepository = {
    hydrateAll: vi.fn().mockResolvedValue([]),
    persistSession: vi.fn().mockResolvedValue(undefined),
    persistMetadata: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const store = new SessionStore({
    sessionRepository: sessionRepository as any,
    workspaceManager: createTestWorkspaceManager(),
  });
  return { store, sessionRepository };
};

const flushPersistQueue = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe('SessionStore flags and metadata helpers', () => {
  it('sets and clears namespaced flags', async () => {
    const { store } = createStore();
    const session = await store.create({ userId: 'u1', modelName: 'test-model' });

    const applied = await store.setFlagAsync(session.id, 'ui.theme', 'dark');
    expect(applied).toBe(true);
    expect(store.get(session.id)?.flags).toEqual({ ui: { theme: 'dark' } });

    const removed = await store.setFlagAsync(session.id, 'ui.theme', undefined);
    expect(removed).toBe(true);
    expect(store.get(session.id)?.flags).toEqual({});

    store.shutdown();
  });

  it('rejects invalid flag paths', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    const applied = await store.setFlagAsync(session.id, 'invalid', true);
    expect(applied).toBe(false);
    expect(store.get(session.id)?.flags).toEqual({});

    store.shutdown();
  });

  it('merges flag namespaces and prunes empty maps', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    await store.setFlagAsync(session.id, 'ui.theme', 'dark');

    const merged = await store.mergeFlagNamespaceAsync(session.id, 'ui', {
      theme: undefined,
      density: 'compact',
    });
    expect(merged).toBe(true);
    expect(store.get(session.id)?.flags).toEqual({ ui: { density: 'compact' } });

    await store.mergeFlagNamespaceAsync(session.id, 'ui', { density: undefined });
    expect(store.get(session.id)?.flags).toEqual({});

    store.shutdown();
  });

  it('returns cloned flags to avoid mutation leaks', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    await store.setFlagAsync(session.id, 'ui.theme', 'dark');
    const flags = store.getFlags(session.id);
    flags.ui = { theme: 'light' };

    expect(store.get(session.id)?.flags).toEqual({ ui: { theme: 'dark' } });

    store.shutdown();
  });

  it('clears all flags when requested', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    await store.setFlagAsync(session.id, 'ui.theme', 'dark');
    const cleared = await store.clearFlagsAsync(session.id);

    expect(cleared).toBe(true);
    expect(store.get(session.id)?.flags).toEqual({});

    store.shutdown();
  });
});

describe('SessionStore plans', () => {
  it('updates plans and steps while persisting metadata', async () => {
    const traceRecorder = {
      write: vi.fn().mockResolvedValue(undefined),
      updateContext: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      persistMetadata: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      traceRecorder: traceRecorder as any,
      workspaceManager: createTestWorkspaceManager(),
    });
    const session = await store.create({ modelName: 'test-model' });

    const plan: PlanItem[] = [
      { id: 'step-1', title: 'Step 1', status: 'pending' },
      { id: 'step-2', title: 'Step 2', status: 'pending' },
    ];

    const updatedPlan = await store.updatePlanAsync(session.id, plan);
    expect(updatedPlan).toBe(true);
    expect(store.get(session.id)?.plan).toHaveLength(2);

    const nextStep = await store.updatePlanStepAsync(session.id, 'step-1', {
      id: 'step-1',
      title: 'Step 1',
      status: 'completed',
    });
    expect(nextStep[0].status).toBe('completed');

    const unchanged = await store.updatePlanStepAsync(session.id, 'missing', {
      id: 'missing',
      title: 'Missing',
      status: 'completed',
    });
    expect(unchanged).toHaveLength(2);

    await flushPersistQueue();
    expect(sessionRepository.persistMetadata).toHaveBeenCalled();
    expect(traceRecorder.write).toHaveBeenCalledWith(
      session.id,
      expect.any(Number),
      expect.objectContaining({ event: 'plan.snapshot' }),
    );

    store.shutdown();
  });

  it('tracks the current plan step id', async () => {
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      persistMetadata: vi.fn().mockResolvedValue(undefined),
    };
    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: createTestWorkspaceManager(),
    });
    const session = await store.create({ modelName: 'test-model' });

    const updated = await store.updateCurrentPlanStepIdAsync(session.id, 'step-9');
    expect(updated).toBe(true);
    expect(store.get(session.id)?.currentPlanStepId).toBe('step-9');

    await flushPersistQueue();
    expect(sessionRepository.persistMetadata).toHaveBeenCalled();

    store.shutdown();
  });
});

describe('SessionStore message metadata', () => {
  it('derives a title from the first user message', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    const longPrompt = '   Plan a secure audit for this system and summarize findings.   ';
    await store.appendMessageAsync(session.id, {
      id: 'm1',
      role: 'user',
      content: longPrompt,
      timestamp: Date.now(),
    });

    const updated = store.get(session.id) as SessionState;
    expect(updated.title).toBe('Plan a secure audit for this system and summarize findings.');

    store.shutdown();
  });

  it('ignores internal user messages when deriving the public session title', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    await store.appendMessageAsync(session.id, {
      id: 'm-internal',
      role: 'user',
      content: 'Internal kickoff prompt',
      timestamp: Date.now(),
      metadata: { visibility: 'internal', source: 'planner_kickoff' },
    });
    await store.appendMessageAsync(session.id, {
      id: 'm-public',
      role: 'user',
      content: 'Find exposed admin routes',
      timestamp: Date.now(),
    });

    const updated = store.get(session.id) as SessionState;
    expect(updated.title).toBe('Find exposed admin routes');

    store.shutdown();
  });

  it('truncates long titles derived from user prompts', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });
    const longPrompt = 'x'.repeat(120);

    await store.appendMessageAsync(session.id, {
      id: 'm2',
      role: 'user',
      content: longPrompt,
      timestamp: Date.now(),
    });

    const updated = store.get(session.id) as SessionState;
    expect(updated.title).toBe(`${'x'.repeat(77)}...`);

    store.shutdown();
  });

  it('tracks in-memory live tool streams for active sessions', async () => {
    const { store, sessionRepository } = createStore();
    const session = await store.create({ modelName: 'test-model' });

    await store.recordLiveToolStartAsync(session.id, 'shell_run', 'ls');
    await store.appendLiveToolOutputAsync(session.id, 'shell_run', 'stdout line');
    await store.recordLiveToolResultAsync(session.id, 'shell_run', { exitCode: 0 });

    const updated = store.get(session.id) as SessionState;
    expect(updated.liveToolStreams).toEqual({
      shell_run: expect.objectContaining({
        name: 'shell_run',
        command: 'ls',
        chunks: ['stdout line'],
        status: 'completed',
        result: { exitCode: 0 },
      }),
    });

    await flushPersistQueue();
    expect(sessionRepository.persistMetadata).toHaveBeenCalled();

    store.shutdown();
  });

  it('omits shell stdout from live tool result metadata when an artifact path exists', async () => {
    const { store } = createStore();
    const session = await store.create({ modelName: 'test-model' });
    const rawStdout = '{"url":"https://noise.example","status_code":200}\n'.repeat(200);

    await store.recordLiveToolResultAsync(session.id, 'wait_for_shell_job', {
      status: 'completed',
      stdout: rawStdout,
      stdoutPath: '.artifacts/shell-jobs/job-1/stdout.log',
      stderr: '',
      exitCode: 0,
    });

    const updated = store.get(session.id) as SessionState;
    const result = updated.liveToolStreams?.wait_for_shell_job?.result as Record<string, unknown>;
    expect(result.stdout).toContain('stdout omitted from live session metadata');
    expect(result.stdout).toContain('.artifacts/shell-jobs/job-1/stdout.log');
    expect(JSON.stringify(result)).not.toContain('https://noise.example');

    store.shutdown();
  });
});

describe('SessionStore hydration', () => {
  it('hydrates missing sessions on demand', async () => {
    const hydratedSession: SessionState = {
      id: 's1',
      messages: [],
      plan: [],
      memory: createEmptyMemory(),
      flags: {},
      workspaceDir: '/tmp/ws',
      createdAt: Date.now(),
      lastActive: Date.now(),
      turn: 0,
      checkpoints: {},
    };
    const sessionRepository = {
      hydrateAll: vi.fn().mockResolvedValue([]),
      persistSession: vi.fn().mockResolvedValue(undefined),
      hydrateSession: vi.fn().mockResolvedValue(hydratedSession),
    };
    const store = new SessionStore({
      sessionRepository: sessionRepository as any,
      workspaceManager: createTestWorkspaceManager(),
    });

    const missing = store.get('s1');
    expect(missing).toBeUndefined();

    await flushPersistQueue();
    expect(sessionRepository.hydrateSession).toHaveBeenCalledWith('s1', undefined);
    expect(store.get('s1')).toEqual(expect.objectContaining({ id: 's1' }));

    store.shutdown();
  });
});
