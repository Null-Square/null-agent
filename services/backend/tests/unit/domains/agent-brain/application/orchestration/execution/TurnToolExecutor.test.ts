import { vi, describe, it, expect, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Use vi.hoisted() for mocks that need to be available in vi.mock factories
const mocks = vi.hoisted(() => ({
  notifyMock: vi.fn(() => Promise.resolve({ id: 'mock-notif' })),
  invokeMock: vi.fn(),
  checkpointCreateMock: vi.fn(),
}));

// Mock notification service using hoisted mock
vi.mock('@/domains/platform/notifications', () => ({
  notificationService: {
    notify: mocks.notifyMock,
  },
  NotificationType: {
    ACTION_REQUIRED: 'action_required',
    SYSTEM: 'system',
  },
}));

import { TurnToolExecutor } from '@/domains/agent-brain/application/orchestration/execution/TurnToolExecutor';
import { TurnMetricsAccumulator } from '@/domains/agent-brain/application/orchestration/execution/TurnMetricsAccumulator';
import { createAttemptKey, createEmptyMemory } from '@/domains/agent-brain/domain/types/memory';

const invokeMock = mocks.invokeMock;
const checkpointCreateMock = mocks.checkpointCreateMock;

const executeWithReceipt = async (
  toolName: string,
  args: Record<string, unknown>,
  options: { toolCallId?: string },
) => {
  const result = await invokeMock(toolName, args, options);
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
  const outcome = record?.forbidden === true || record?.denied === true
    ? 'blocked'
    : record?.ok === false || record?.success === false || typeof record?.error === 'string'
      ? 'failed'
      : 'succeeded';
  return {
    result,
    receipt: {
      schema: 'tool-execution-receipt/v1' as const,
      toolName,
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      outcome,
    },
  };
};

const createExecutor = (deps?: Partial<ConstructorParameters<typeof TurnToolExecutor>[0]>) => {
  const sessionStore = {
    appendMessageAsync: vi.fn(),
    heartbeat: vi.fn(),  // Required for watchdog timeout prevention
    get: vi.fn().mockReturnValue({ userId: 'test-user-123' }),
  };
  const stream = {
    message: vi.fn(),
    done: vi.fn(),
    raw: vi.fn(),
  };
  const executor = new TurnToolExecutor({
    sessionStore: sessionStore as any,
    toolsRegistry: {
      execute: invokeMock,
      executeWithReceipt,
      flushWorkspaceProjection: deps?.toolsRegistry?.flushWorkspaceProjection,
    } as any,
    checkpointManager: deps?.checkpointManager as any,
    checkpointIntervalToolCalls: deps?.checkpointIntervalToolCalls,
  });
  return { executor, sessionStore, stream };
};

describe('TurnToolExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the runner turn number to tool registry execution', async () => {
    const { executor, stream } = createExecutor();
    invokeMock.mockResolvedValue({ ok: true });

    await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [{ id: 'tc-turn', function: { name: 'echo', arguments: '{}' } }] as any,
      stream: stream as any,
      turnNumber: 4,
    });

    expect(invokeMock).toHaveBeenCalledWith(
      'echo',
      {},
      expect.objectContaining({
        sessionId: 's1',
        toolCallId: 'tc-turn',
        turnNumber: 4,
        rawArgsJson: '{}',
      }),
    );
  });

  it('flushes workspace projection once after a tool batch', async () => {
    const flushWorkspaceProjection = vi.fn().mockResolvedValue({
      flushed: true,
      scopes: ['recon', 'model'],
      written: 2,
      dirtyCount: 3,
    });
    const { executor, stream } = createExecutor({
      toolsRegistry: { flushWorkspaceProjection } as any,
    });
    invokeMock.mockResolvedValue({ ok: true, success: true });

    await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        { id: 'tc-1', function: { name: 'report_note', arguments: '{"title":"a"}' } },
        { id: 'tc-2', function: { name: 'report_note', arguments: '{"title":"b"}' } },
      ] as any,
      stream: stream as any,
      turnNumber: 4,
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(flushWorkspaceProjection).toHaveBeenCalledTimes(1);
    expect(flushWorkspaceProjection).toHaveBeenCalledWith({
      sessionId: 's1',
      turnNumber: 4,
      reason: 'turn_boundary',
    });
  });

  it('surfaces projection flush warnings in the last tool result', async () => {
    const flushWorkspaceProjection = vi.fn().mockResolvedValue({
      flushed: false,
      scopes: ['model'],
      written: 0,
      dirtyCount: 1,
      warning: 'Projection refresh failed after turn_boundary: runner offline.',
    });
    const { executor, stream } = createExecutor({
      toolsRegistry: { flushWorkspaceProjection } as any,
    });
    invokeMock.mockResolvedValue({ ok: true, success: true });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [{ id: 'tc-1', function: { name: 'report_note', arguments: '{"title":"a"}' } }] as any,
      stream: stream as any,
      turnNumber: 4,
    });

    expect(result.collectedToolResults[0]?.content).toContain('workspaceProjectionWarning');
    expect(JSON.stringify(result.currentMessages[0])).toContain('runner offline');
  });

  it('skips repeated tool calls within a turn instead of deadlocking', async () => {
    // Repetition detection is per-turn only (cleared at run start).
    // The third identical call is converted into a tool result so the model can recover.
    const { executor, sessionStore, stream } = createExecutor();
    invokeMock.mockResolvedValue({ ok: true });

    const toolCall = { id: 'tc1', function: { name: 'ls', arguments: '{}' } } as any;
    
    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [toolCall, toolCall, toolCall], // 3 identical calls
      stream: stream as any,
    });

    expect(result.status).toBeUndefined();
    expect(result.doneEmitted).toBeUndefined();
    expect(result.toolCallCount).toBe(3);
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'tc1',
        toolName: 'ls',
        reason: 'repeated_identical_tool_call',
      }),
    ]);
    expect(result.collectedToolResults[2]?.content).toContain('repeated_identical_tool_call');
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(sessionStore.appendMessageAsync).not.toHaveBeenCalled();
    expect(stream.raw).toHaveBeenCalledWith('tool_result', expect.objectContaining({
      name: 'ls',
      result: expect.objectContaining({
        reason: 'repeated_identical_tool_call',
      }),
    }));
    expect(stream.done).not.toHaveBeenCalled();
  });

  it('REGRESSION: does NOT deadlock across separate runs (per-turn reset)', async () => {
    // FIX (Dec 2025): Each run() call clears the deadlock detector
    // Same tool+args called once per run should NEVER trigger deadlock
    const { executor, stream } = createExecutor();
    invokeMock.mockResolvedValue({ ok: true });

    const toolCall = { id: 'tc1', function: { name: 'file_write', arguments: '{"path":"summary.md"}' } } as any;
    
    // Run 1: 1 tool call
    const result1 = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [toolCall],
      stream: stream as any,
    });
    expect(result1.status).not.toBe('deadlock');

    // Run 2: 1 tool call (same args)
    const result2 = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [toolCall],
      stream: stream as any,
    });
    expect(result2.status).not.toBe('deadlock');

    // Run 3: 1 tool call (same args) - should NOT deadlock because detector is cleared
    const result3 = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [toolCall],
      stream: stream as any,
    });
    expect(result3.status).not.toBe('deadlock');
  });

  it('returns awaiting_approval immediately when submit_plan hands off to plan approval', async () => {
    const { executor, stream } = createExecutor();
    invokeMock.mockResolvedValue({
      runId: 'run-1',
      status: 'awaiting_approval',
      awaitingPlanApproval: true,
      assignedSkillSlugs: ['sql-injection'],
      control: {
        kind: 'awaiting_approval',
        reason: 'plan_submission',
        runId: 'run-1',
      },
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [{ id: 'tc-submit-plan', function: { name: 'submit_plan', arguments: '{}' } }] as any,
      stream: stream as any,
    });

    expect(result.status).toBe('awaiting_approval');
    expect(result.awaitingApprovalContext).toEqual({
      kind: 'plan_submission',
      runId: 'run-1',
    });
    expect(result.pendingApproval).toBeUndefined();
    expect(result.toolCallCount).toBe(1);
    expect(result.collectedToolResults).toHaveLength(1);
    expect(result.collectedToolResults[0].toolCallId).toBe('tc-submit-plan');
  });

  it('auto-checkpoints in automated mode at the configured interval', async () => {
    const { executor, stream } = createExecutor({
      checkpointManager: { create: checkpointCreateMock.mockResolvedValue({ id: 'cp1' }) } as any,
      checkpointIntervalToolCalls: 2,
    });
    invokeMock.mockResolvedValueOnce({ ok: true });
    invokeMock.mockResolvedValueOnce({ ok: true });

    await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        { id: 'tc1', function: { name: 'a', arguments: '{}' } },
        { id: 'tc2', function: { name: 'b', arguments: '{}' } },
      ] as any,
      stream: stream as any,
      isAutomated: true,
      sessionToolCallCount: 0,
    });

    expect(checkpointCreateMock).toHaveBeenCalledWith('s1');
    expect(stream.raw).toHaveBeenCalledWith('checkpoint_created', expect.objectContaining({ id: 'cp1' }));
  });

  it('persists oversized tool results under .artifacts with a compact prompt envelope', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'null-ai-tool-result-'));
    try {
      const { executor, sessionStore, stream } = createExecutor();
      sessionStore.get.mockReturnValue({ userId: 'test-user-123', workspaceDir });
      invokeMock.mockResolvedValueOnce({
        ok: true,
        output: 'x'.repeat(25_000),
      });

      const result = await executor.run({
        sessionId: 's1',
        abortSignal: new AbortController().signal,
        toolCalls: [{ id: 'tc-large', function: { name: 'shell_run', arguments: '{}' } }] as any,
        stream: stream as any,
      });

      const content = String(result.collectedToolResults[0]?.content ?? '');
      const payload = JSON.parse(content) as Record<string, any>;
      expect(payload.status).toBe('tool_result_persisted');
      expect(payload.artifact.path).toContain('/workspace/.artifacts/tool-results/tc-large-');
      const relativePath = payload.artifact.path.replace('/workspace/', '');
      await expect(fs.readFile(path.join(workspaceDir, relativePath), 'utf8')).resolves.toContain('"output"');
      expect(payload.policy.savedApproxTokens).toBeGreaterThan(0);
      expect(content.length).toBeLessThan(4_000);
      expect(result.toolResultEvents).toEqual([
        expect.objectContaining({
          toolName: 'shell_run',
          toolCallId: 'tc-large',
          persisted: true,
        }),
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('records http 401 attempts as blocked in memory updates', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 401,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-401',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({ url: 'https://api.example.com/login', method: 'GET' }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(result.memoryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: expect.objectContaining({
            value: expect.objectContaining({ result: 'blocked' }),
          }),
        }),
      ]),
    );
  });

  it('records http 5xx attempts as failed in memory updates', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 500,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-500',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({ url: 'https://api.example.com/login', method: 'GET' }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(result.memoryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: expect.objectContaining({
            value: expect.objectContaining({ result: 'failed' }),
          }),
        }),
      ]),
    );
  });

  it('uses probe technique for versioned health endpoints in the skip check', async () => {
    const memory = createEmptyMemory();
    memory.attemptedTechniques[createAttemptKey('https://api.example.com/api/v1/health', 'probe')] = {
      count: 1,
      lastAttemptTurn: 0,
      result: 'success',
      lastAttemptAt: Date.now(),
    };
    memory.testedEndpoints.push('https://api.example.com/api/v1/health');
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-health',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({ url: 'https://api.example.com/api/v1/health', method: 'GET' }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        endpoint: 'https://api.example.com/api/v1/health',
        technique: 'probe',
      }),
    ]);
  });

  it('allows same-turn http_payload retries when material request parameters change', async () => {
    const memory = createEmptyMemory();
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 7,
      memory,
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 500,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-small',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              max_body_bytes: 65536,
            }),
          },
        },
        {
          id: 'tc-http-large',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              max_body_bytes: 250000,
            }),
          },
        },
      ] as any,
      stream: stream as any,
      turnNumber: 7,
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.skippedToolCalls).toEqual([]);
    expect(Object.keys(memory.attemptedTechniques)).toHaveLength(2);
  });

  it('skips identical same-turn http_payload retries after the first recorded attempt', async () => {
    const memory = createEmptyMemory();
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 7,
      memory,
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 500,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-first',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              max_body_bytes: 65536,
            }),
          },
        },
        {
          id: 'tc-http-duplicate',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              max_body_bytes: 65536,
            }),
          },
        },
      ] as any,
      stream: stream as any,
      turnNumber: 7,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'tc-http-duplicate',
        reason: 'Already attempted in current turn',
        endpoint: 'https://api.example.com/openapi.json',
      }),
    ]);
    expect(Object.keys(memory.attemptedTechniques)).toHaveLength(1);
  });

  it('treats equivalent header order as the same http_payload attempt signature', async () => {
    const memory = createEmptyMemory();
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 7,
      memory,
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 500,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-headers-a',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              headers: { Accept: 'application/json', 'X-Test': '1' },
            }),
          },
        },
        {
          id: 'tc-http-headers-b',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/openapi.json',
              method: 'GET',
              headers: { 'X-Test': '1', Accept: 'application/json' },
            }),
          },
        },
      ] as any,
      stream: stream as any,
      turnNumber: 7,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'tc-http-headers-b',
        reason: 'Already attempted in current turn',
      }),
    ]);
  });

  it('skips same-batch execution tools until the active step methodology is read', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    const session = {
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
      flags: {},
    } as any;
    sessionStore.get.mockReturnValue(session);
    invokeMock.mockImplementation(async (toolName: string) => {
      if (toolName === 'plan_set_step_status') {
        session.currentPlanStepId = 'task-2';
        session.flags.activeMethodologyRequirement = {
          stepId: 'task-2',
          skills: ['api-enumeration'],
          paths: ['/workspace/.skills/api-enumeration/methodology.md'],
        };
        return { success: true };
      }
      return { success: true };
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-start',
          function: {
            name: 'plan_set_step_status',
            arguments: JSON.stringify({ stepId: 'task-2', status: 'running' }),
          },
        },
        {
          id: 'tc-http',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://example.com/wp-json/wp/v2/users',
              method: 'GET',
              technique: 'api-enumeration',
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      'plan_set_step_status',
      {},
      expect.any(Object),
    );
    expect(result.skippedToolCalls).toEqual([
      expect.objectContaining({
        toolCallId: 'tc-http',
        toolName: 'http_payload',
        endpoint: 'https://example.com/wp-json/wp/v2/users',
        technique: 'api-enumeration',
        reason: expect.stringContaining('/workspace/.skills/api-enumeration/methodology.md'),
      }),
    ]);
    expect(JSON.parse(result.collectedToolResults[1].content as string)).toEqual(
      expect.objectContaining({
        skipped: true,
        activePlanStepId: 'task-2',
        requiredMethodologySkills: ['api-enumeration'],
      }),
    );
  });

  it('allows same-batch execution after file_read records the active step methodology', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    const session = {
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
      currentPlanStepId: 'task-2',
      flags: {
        activeMethodologyRequirement: {
          stepId: 'task-2',
          skills: ['api-enumeration'],
          paths: ['/workspace/.skills/api-enumeration/methodology.md'],
        },
      },
    } as any;
    sessionStore.get.mockReturnValue(session);
    invokeMock.mockImplementation(async (toolName: string) => {
      if (toolName === 'file_read') {
        session.flags.skillMethodologyReads = {
          'api-enumeration': {
            readAt: new Date().toISOString(),
            byPlanStepId: 'task-2',
            path: '/workspace/.skills/api-enumeration/methodology.md',
          },
        };
        delete session.flags.activeMethodologyRequirement;
        return { ok: true, data: { content: '# API Enumeration' } };
      }
      return { success: true, status_code: 200 };
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-read',
          function: {
            name: 'file_read',
            arguments: JSON.stringify({ path: '/workspace/.skills/api-enumeration/methodology.md' }),
          },
        },
        {
          id: 'tc-http',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://example.com/wp-json/wp/v2/users',
              method: 'GET',
              technique: 'api-enumeration',
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.skippedToolCalls).toEqual([]);
    expect(result.collectedToolResults).toHaveLength(2);
    expect(result.collectedToolResults[1].toolCallId).toBe('tc-http');
  });

  it('respects explicit technique for http_payload memory recording', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
    });
    invokeMock.mockResolvedValue({
      success: true,
      status_code: 200,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-idor',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://api.example.com/users/123',
              method: 'GET',
              technique: 'idor',
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(result.memoryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change: expect.objectContaining({
            value: expect.objectContaining({ technique: 'idor', result: 'success' }),
          }),
        }),
      ]),
    );
  });

  it('does not record 404 http_payload responses in memory', async () => {
    const memory = createEmptyMemory();
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory,
    });
    invokeMock.mockResolvedValue({
      success: false,
      status_code: 404,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-404',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({ url: 'https://api.example.com/api/v1/health', method: 'GET' }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(result.memoryUpdates).toEqual([]);
    expect(memory.attemptedTechniques).toEqual({});
    expect(memory.failedApproaches).toEqual([]);
  });

  it('records endpoint fact when http_payload succeeds on a newly seen endpoint', async () => {
    const memory = createEmptyMemory();
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory,
    });
    invokeMock.mockResolvedValue({
      success: true,
      status_code: 200,
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-200',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({ url: 'https://api.example.com/new-endpoint', method: 'GET' }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(result.memoryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'fact_added',
          change: expect.objectContaining({
            key: 'endpoint:https://api.example.com/new-endpoint',
          }),
        }),
      ]),
    );
  });

  it('does not enforce legacy manual-http-login gating when access materials are unchecked', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
      flags: {
        securityops: {
          accessMaterials: {
            availableCount: 1,
            listChecked: false,
            usedByHost: {},
            materials: [
              {
                id: 'material-1',
                kind: 'login_credential',
                label: 'App Login',
                username: 'demo@example.com',
                headerName: null,
                notes: null,
                appliesToHosts: ['app.nullsquare.net'],
              },
            ],
          },
        },
      },
    });
    invokeMock.mockResolvedValue({ success: false, status_code: 401 });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-login',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://app.nullsquare.net/api/auth/login',
              method: 'POST',
              body: JSON.stringify({ email: 'demo@example.com', password: 'guess' }),
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.collectedToolResults).toHaveLength(1);
    expect(result.collectedToolResults[0].toolCallId).toBe('tc-http-login');
  });

  it('does not enforce legacy manual-http-login gating when a matching saved material exists', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
      flags: {
        securityops: {
          accessMaterials: {
            availableCount: 1,
            listChecked: true,
            usedByHost: {},
            materials: [
              {
                id: 'material-1',
                kind: 'login_credential',
                label: 'App Login',
                username: 'demo@example.com',
                headerName: null,
                notes: 'Use this on app.nullsquare.net',
                appliesToHosts: ['app.nullsquare.net'],
              },
            ],
          },
        },
      },
    });
    invokeMock.mockResolvedValue({ success: false, status_code: 401 });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-login',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://app.nullsquare.net/api/auth/login',
              method: 'POST',
              body: JSON.stringify({ email: 'demo@example.com', password: 'guess' }),
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.collectedToolResults[0].toolCallId).toBe('tc-http-login');
  });

  it('allows manual http login when no matching saved material exists for the host', async () => {
    const { executor, sessionStore, stream } = createExecutor();
    sessionStore.get.mockReturnValue({
      userId: 'test-user-123',
      turn: 1,
      memory: createEmptyMemory(),
      flags: {
        securityops: {
          accessMaterials: {
            availableCount: 1,
            listChecked: true,
            usedByHost: {},
            materials: [
              {
                id: 'material-1',
                kind: 'login_credential',
                label: 'App Login',
                username: 'demo@example.com',
                headerName: null,
                notes: null,
                appliesToHosts: ['app.nullsquare.net'],
              },
            ],
          },
        },
      },
    });
    invokeMock.mockResolvedValue({ success: false, status_code: 401 });

    await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-login',
          function: {
            name: 'http_payload',
            arguments: JSON.stringify({
              url: 'https://grafana.nullsquare.net/login',
              method: 'POST',
              body: JSON.stringify({ username: 'demo', password: 'guess' }),
            }),
          },
        },
      ] as any,
      stream: stream as any,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it('records logical tool failure in metrics and action summaries for normalized payload errors', async () => {
    const { executor, stream } = createExecutor();
    const metrics = new TurnMetricsAccumulator();
    invokeMock.mockResolvedValue({
      success: false,
      error: 'HTTP capture entry abc123 not found',
    });

    const result = await executor.run({
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      toolCalls: [
        {
          id: 'tc-http-repeat',
          function: {
            name: 'http_repeat',
            arguments: JSON.stringify({ entry_id: 'abc123' }),
          },
        },
      ] as any,
      stream: stream as any,
      metricsAccumulator: metrics,
    });

    expect(result.actionSummaries).toEqual([
      expect.objectContaining({
        tool: 'http_repeat',
        outcome: 'failure',
        outcomeReason: 'HTTP capture entry abc123 not found',
      }),
    ]);
    expect(metrics.toPayload().tools).toEqual([
      expect.objectContaining({
        name: 'http_repeat',
        success: false,
      }),
    ]);
  });
});
