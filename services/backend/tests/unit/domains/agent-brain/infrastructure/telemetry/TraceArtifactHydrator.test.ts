import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  SessionTraceRecorder,
  TimelineService,
  TraceArtifactIntegrityError,
} from '@/domains/agent-brain/infrastructure/telemetry';

describe('trace artifact hydration modes', () => {
  it('keeps correlation inline, verifies strict detail, and detects corruption', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-hydration-'));
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 256,
      compressOverBytes: 100_000,
    });
    await recorder.init('session-1', { workspace: '/tmp/ws', tools: [], model: 'model-1' });

    const write = await recorder.write('session-1', 1, {
      event: 'tool.finish',
      payload: {
        requestId: 'request-1',
        toolCallId: 'tool-call-1',
        name: 'neutral_marker',
        status: 'completed',
        outcome: 'success',
        marker: 'durable-marker',
        detail: 'x'.repeat(2_000),
      },
    });
    expect(write).toEqual({
      accepted: true,
      eventId: expect.any(String),
      acceptedOrdinal: 2,
    });
    await recorder.close('session-1', { terminal: 'session.done', status: 'completed' });

    const timeline = new TimelineService({ traceRoot: rootDir });
    const inline = await timeline.getAllEvents('session-1', 'inline');
    const inlineFinish = inline.find((event) => event.event === 'tool.finish');
    expect(inlineFinish).toMatchObject({
      schemaVersion: 3,
      acceptedOrdinal: 2,
      requestId: 'request-1',
      toolCallId: 'tool-call-1',
      name: 'neutral_marker',
      status: 'completed',
      outcome: 'success',
      artifactRef: expect.stringMatching(/^artifacts\//u),
      artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      hydration: { mode: 'inline', status: 'artifact_unhydrated' },
    });
    expect(inlineFinish?.payload).toMatchObject({ truncated: true });

    const strict = await timeline.getAllEvents('session-1', 'strict');
    expect(strict.find((event) => event.event === 'tool.finish')).toMatchObject({
      payload: { marker: 'durable-marker', toolCallId: 'tool-call-1' },
      hydration: { mode: 'strict', status: 'hydrated' },
    });

    const artifactPath = path.join(rootDir, 'session-1', inlineFinish!.artifactRef!);
    fs.appendFileSync(artifactPath, 'corrupt');
    await expect(timeline.getAllEvents('session-1', 'strict')).rejects.toBeInstanceOf(
      TraceArtifactIntegrityError,
    );
    const degraded = await timeline.getAllEvents('session-1', 'hydrated');
    expect(degraded.find((event) => event.event === 'tool.finish')?.hydration?.status)
      .toBe('digest_mismatch');

    const closeWrite = await recorder.write('session-1', 2, { event: 'too.late' });
    expect(closeWrite).toEqual({ accepted: false, reason: 'closed' });

    const integrity = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'session-1', 'integrity.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(integrity).toMatchObject({
      schema: 'trace-integrity/v1',
      status: 'complete',
      acceptedHighWater: 2,
      persistedHighWater: 2,
    });
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
