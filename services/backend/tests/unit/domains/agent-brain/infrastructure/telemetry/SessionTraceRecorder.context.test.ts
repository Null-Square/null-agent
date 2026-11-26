import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';

describe('SessionTraceRecorder v3 context envelope', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-context-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('stamps schema, run, role, phase, and worker context on every event', async () => {
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 4096,
      compressOverBytes: 10_000,
    });

    recorder.updateContext('sess-ctx', {
      runId: 'run-1',
      agentType: 'executor',
      agentRole: 'phase:validation',
      phaseId: 'phase-1',
      workerTaskId: 'task-1',
      context: {
        userId: 'user-1',
        tier: 'control',
        model: 'model-from-context',
        imageId: 'image-1',
      },
    });

    await recorder.init('sess-ctx', {
      workspace: '/tmp/ws',
      tools: ['shell_run'],
      model: 'model-from-seed',
    });
    await recorder.write('sess-ctx', 1, {
      event: 'tool.finish',
      payload: { toolName: 'shell_run', outcome: 'success' },
    });
    await recorder.close('sess-ctx', { terminal: 'session.done', status: 'completed', turns: 1 });

    const records = fs
      .readFileSync(path.join(rootDir, 'sess-ctx', 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const init = records.find((record) => record.event === 'session.init');
    const toolFinish = records.find((record) => record.event === 'tool.finish');

    expect(init).toEqual(expect.objectContaining({
      schemaVersion: 3,
      sessionId: 'sess-ctx',
      runId: 'run-1',
      agentType: 'executor',
      agentRole: 'phase:validation',
      phaseId: 'phase-1',
      workerTaskId: 'task-1',
      userId: 'user-1',
      tier: 'control',
      model: 'model-from-context',
      imageId: 'image-1',
    }));
    expect(init.payload).toEqual(expect.objectContaining({
      runId: 'run-1',
      agentRole: 'phase:validation',
      phaseId: 'phase-1',
      workerTaskId: 'task-1',
    }));
    expect(toolFinish).toEqual(expect.objectContaining({
      schemaVersion: 3,
      runId: 'run-1',
      agentRole: 'phase:validation',
      phaseId: 'phase-1',
      workerTaskId: 'task-1',
    }));
  });

  it('writes redacted JSON artifacts that can be linked from compact events', async () => {
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 4096,
      compressOverBytes: 10_000,
    });

    await recorder.init('sess-artifact', {
      workspace: '/tmp/ws',
      tools: [],
      model: 'gpt-test',
    });

    const artifact = recorder.writeJsonArtifact('sess-artifact', 'model-call-messages', {
      api_key: 'supersecret',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await recorder.write('sess-artifact', 1, {
      event: 'model.call.start',
      payload: { messages: 1 },
      links: artifact ? { messages: artifact } : undefined,
    });
    await recorder.close('sess-artifact', { terminal: 'session.done', status: 'completed', turns: 1 });

    expect(artifact).toBeTruthy();
    const artifactPath = path.join(rootDir, 'sess-artifact', artifact!);
    const artifactPayload = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    expect(artifactPayload.api_key).not.toBe('supersecret');
    expect(artifactPayload.messages).toEqual([{ role: 'user', content: 'hello' }]);

    const records = fs
      .readFileSync(path.join(rootDir, 'sess-artifact', 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.find((record) => record.event === 'model.call.start')?.links).toEqual({ messages: artifact });
  });
});
