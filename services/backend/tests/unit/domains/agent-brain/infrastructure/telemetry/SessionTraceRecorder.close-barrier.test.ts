import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';

import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';

describe('SessionTraceRecorder close barrier', () => {
  it('waits for an accepted artifact write and persists the matching high-water mark', async () => {
    let releaseArtifact!: () => void;
    const artifactUpload = new Promise<void>((resolve) => {
      releaseArtifact = resolve;
    });
    const uploadBuffer = vi.fn((key: string, _content: Buffer): Promise<void> =>
      key.includes('/artifacts/') ? artifactUpload : Promise.resolve());
    const recorder = new SessionTraceRecorder(
      {
        rootDir: path.join(os.tmpdir(), 'trace-close-barrier'),
        keepLocalCopy: false,
        inlineLimit: 512,
        compressOverBytes: 100_000,
        s3FlushIntervalMs: 60_000,
        s3FlushMaxEvents: 100,
      },
      {
        client: {
          ensureBucket: vi.fn().mockResolvedValue(undefined),
          uploadBuffer,
        } as never,
        bucket: 'trace-bucket',
      },
    );
    await recorder.init('session-close', { workspace: '/tmp/ws', tools: [], model: 'model-1' });

    const pendingWrite = recorder.write('session-close', 1, {
      event: 'tool.finish',
      payload: {
        toolCallId: 'call-1',
        name: 'neutral_marker',
        outcome: 'success',
        marker: 'x'.repeat(2_000),
      },
    });
    await vi.waitFor(() => {
      expect(uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining('/artifacts/'),
        expect.any(Buffer),
      );
    });

    let closed = false;
    const pendingClose = recorder.close('session-close', {
      terminal: 'session.done',
      status: 'completed',
    }).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseArtifact();
    expect(await pendingWrite).toMatchObject({ accepted: true, acceptedOrdinal: 2 });
    await pendingClose;
    expect(closed).toBe(true);

    const indexCall = uploadBuffer.mock.calls.find(([key]) => key === 'session-close/index.json');
    expect(indexCall).toBeDefined();
    const index = JSON.parse(Buffer.from(indexCall![1] as Buffer).toString('utf8'));
    expect(index).toMatchObject({
      acceptedHighWater: 2,
      persistedHighWater: 2,
      integrityStatus: 'complete',
      integrity: { status: 'complete' },
    });
  });

  it('returns writer_failed and persists failed integrity when a required artifact is rejected', async () => {
    const objects = new Map<string, Buffer>();
    const uploadBuffer = vi.fn(async (key: string, content: Buffer): Promise<void> => {
      if (key.includes('/artifacts/')) throw new Error('artifact store unavailable');
      objects.set(key, Buffer.from(content));
    });
    const recorder = new SessionTraceRecorder(
      {
        rootDir: path.join(os.tmpdir(), 'trace-close-failed'),
        keepLocalCopy: false,
        inlineLimit: 512,
        compressOverBytes: 100_000,
        s3FlushIntervalMs: 60_000,
        s3FlushMaxEvents: 100,
      },
      {
        client: {
          ensureBucket: vi.fn().mockResolvedValue(undefined),
          uploadBuffer,
        } as never,
        bucket: 'trace-bucket',
      },
    );
    await recorder.init('session-failed', { workspace: '/tmp/ws', tools: [], model: 'model-1' });
    const result = await recorder.write('session-failed', 1, {
      event: 'tool.finish',
      payload: {
        toolCallId: 'call-failed',
        outcome: 'success',
        marker: 'x'.repeat(2_000),
      },
    });
    expect(result).toEqual({ accepted: false, reason: 'writer_failed' });

    await recorder.close('session-failed', { terminal: 'error', status: 'failed' });
    const index = JSON.parse(objects.get('session-failed/index.json')!.toString('utf8'));
    expect(index).toMatchObject({
      acceptedHighWater: 1,
      persistedHighWater: 1,
      integrityStatus: 'failed',
      integrity: { status: 'failed' },
    });
  });
});
