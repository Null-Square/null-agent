import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionToolInvocationRecorder } from '@/domains/agent-brain/infrastructure/history/sessionToolInvocationRecorder';

const uuidMocks = vi.hoisted(() => ({
  v4: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: uuidMocks.v4,
}));

describe('SessionToolInvocationRecorder', () => {
  beforeEach(() => {
    uuidMocks.v4.mockReset();
  });

  it('records invocation ids per session', async () => {
    uuidMocks.v4.mockReturnValueOnce('inv-1');
    const recorder = new SessionToolInvocationRecorder();

    const id = await recorder.recordStart({ sessionId: 's1', toolId: 'tool' });

    expect(id).toBe('inv-1');
    expect(recorder.getLatestInvocationId('s1')).toBe('inv-1');
  });

  it('returns null without a session id', async () => {
    const recorder = new SessionToolInvocationRecorder();

    const id = await recorder.recordStart({ toolId: 'tool' });

    expect(id).toBeNull();
  });

  it('records artifacts when no invocation exists', async () => {
    uuidMocks.v4.mockReturnValueOnce('inv-2');
    const recorder = new SessionToolInvocationRecorder();

    await recorder.recordArtifactsForSession('s2', [{ path: '/tmp/file.txt' }]);

    expect(recorder.getLatestInvocationId('s2')).toBe('inv-2');
  });

  it('preserves existing invocation ids on artifact records', async () => {
    uuidMocks.v4.mockReturnValueOnce('inv-3');
    const recorder = new SessionToolInvocationRecorder();

    await recorder.recordStart({ sessionId: 's3', toolId: 'tool' });
    await recorder.recordArtifactsForSession('s3', [{ path: '/tmp/file.txt' }]);

    expect(recorder.getLatestInvocationId('s3')).toBe('inv-3');
    expect(uuidMocks.v4).toHaveBeenCalledTimes(1);
  });
});
