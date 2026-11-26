import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { ToolTelemetry } from '@/domains/agent-brain/adapters/tools/ToolTelemetry';

function getRecorderMocks(): Record<string, Mock> {
  const globalObj = global as any;
  if (!globalObj.__recorderMocks) {
    globalObj.__recorderMocks = {};
  }
  return globalObj.__recorderMocks;
}

vi.mock('@/domains/agent-brain/infrastructure/history/sessionToolInvocationRecorder', () => {
  const recordStart = vi.fn();
  const recordSuccess = vi.fn();
  const recordFailure = vi.fn();

  const mocks = getRecorderMocks();
  mocks.recordStart = recordStart;
  mocks.recordSuccess = recordSuccess;
  mocks.recordFailure = recordFailure;

  return {
    __esModule: true,
    default: class {
      recordStart = recordStart;
      recordSuccess = recordSuccess;
      recordFailure = recordFailure;
    },
    sessionToolInvocationRecorder: {
      recordStart,
      recordSuccess,
      recordFailure,
    },
  };
});

describe('ToolTelemetry', () => {
  const telemetry = new ToolTelemetry();
  const recorder = { write: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records start with args hash and trace entry', async () => {
    const mocks = getRecorderMocks();
    mocks.recordStart.mockResolvedValueOnce('inv-1');

    const meta = await telemetry.recordStart(
      's1',
      'shell_run',
      { cmd: 'ls' },
      1,
      'step-1',
      recorder as any,
      {
        toolCallId: 'call-1',
        permission: { behavior: 'allow', source: 'policy' },
      },
    );

    expect(mocks.recordStart).toHaveBeenCalledWith({
      sessionId: 's1',
      toolId: 'shell_run',
      stepId: 'step-1',
      input: { cmd: 'ls' },
    });
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      1,
      expect.objectContaining({
        event: 'tool.start',
        payload: expect.objectContaining({
          toolName: 'shell_run',
          name: 'shell_run',
          toolCallId: 'call-1',
          planStepId: 'step-1',
          permission: { behavior: 'allow', source: 'policy' },
          argsHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    );
    expect(meta.invocationId).toBe('inv-1');
    expect(meta.argsHash).toHaveLength(64);
    expect(meta.toolCallId).toBe('call-1');
    expect(meta.planStepId).toBe('step-1');
  });

  it('records finish and forwards to invocation recorder', async () => {
    const meta = { invocationId: 'inv-2', argsHash: 'hash', startedAt: Date.now() - 10 };

    await telemetry.recordFinish('s1', 'write_file', { ok: true }, 2, meta, recorder as any);

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      2,
      expect.objectContaining({
        event: 'tool.finish',
        payload: expect.objectContaining({
          toolName: 'write_file',
          name: 'write_file',
          success: true,
          outcome: 'success',
        }),
      }),
    );
    expect(getRecorderMocks().recordSuccess).toHaveBeenCalledWith('inv-2', { ok: true });
  });

  it('records denied failure and error failure', async () => {
    const deniedMeta = { invocationId: 'inv-3', argsHash: 'hash', startedAt: Date.now() - 5 };

    await telemetry.recordFailure('s1', 'exec', new Error('no'), 3, deniedMeta, recorder as any, true, 'policy_denied');

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      3,
      expect.objectContaining({
        event: 'tool.finish',
        payload: expect.objectContaining({
          denied: true,
          outcome: 'blocked',
          outcomeReason: 'policy_denied',
          reason: 'policy_denied',
        }),
      }),
    );
    expect(getRecorderMocks().recordFailure).toHaveBeenCalledWith('inv-3', expect.any(Error));

    const errorMeta = { invocationId: 'inv-4', argsHash: 'hash', startedAt: Date.now() - 5 };
    await telemetry.recordFailure('s1', 'read', new Error('boom'), 4, errorMeta, recorder as any);
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      4,
      expect.objectContaining({
        event: 'tool.finish',
        payload: expect.objectContaining({
          toolName: 'read',
          outcome: 'error',
          outcomeReason: 'boom',
          success: false,
        }),
      }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      4,
      expect.objectContaining({ event: 'error', payload: expect.objectContaining({ class: 'tool', name: 'read' }) }),
    );
  });

  it('records forbidden and abort events', async () => {
    const meta = { invocationId: null, argsHash: 'hash', startedAt: Date.now() - 5 };

    await telemetry.recordForbidden('s1', 'delete', 5, recorder as any);
    await telemetry.recordAbort('s1', 'long_tool', 6, meta.startedAt, recorder as any);

    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      5,
      expect.objectContaining({ event: 'tool.forbidden', payload: expect.objectContaining({ name: 'delete' }) }),
    );
    expect(recorder.write).toHaveBeenCalledWith(
      's1',
      6,
      expect.objectContaining({ event: 'tool.abort', payload: expect.objectContaining({ name: 'long_tool' }) }),
    );
  });

  it('truncates large string results and preserves metadata', async () => {
    const longString = 'x'.repeat(600);
    const meta = { invocationId: null, argsHash: 'hash', startedAt: Date.now() - 10 };

    await telemetry.recordFinish('s1', 'big_output_tool', longString, 7, meta as any, recorder as any);

    const writeCall = recorder.write.mock.calls.find(([, , record]) => record.event === 'tool.finish');
    expect(writeCall).toBeDefined();
    const payload = writeCall![2].payload as any;
    expect(payload.name).toBe('big_output_tool');
    expect(payload.result).toEqual(
      expect.objectContaining({
        preview: expect.stringMatching(/^x{512}$/),
        length: 600,
        truncated: true,
      }),
    );
  });
});







