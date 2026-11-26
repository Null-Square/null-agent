import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';

const seed = {
  workspace: '/tmp/ws',
  tools: [],
  model: 'gpt-test',
};

describe('SessionTraceRecorder redaction', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-recorder-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('spills large payloads to artifacts and redacts secrets', async () => {
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 32,
      compressOverBytes: 10_000,
    });

    await recorder.init('sess-1', seed);
    await recorder.write('sess-1', 1, {
      event: 'error',
      payload: {
        api_key: 'supersecret',
        Authorization: 'Authorization: Bearer abcdef123456',
        url: 'https://example.com?token=abc123&safe=yes',
        note: 'x'.repeat(128),
      },
      note: 'oops',
    });
    await recorder.close('sess-1', { terminal: 'session.done', status: 'completed', turns: 1 });

    const tracePath = path.join(rootDir, 'sess-1', 'trace.ndjson');
    const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
    const record = lines.map((line) => JSON.parse(line)).find((row) => row.event === 'error');

    expect(record).toBeDefined();
    expect(record.payload).toEqual(expect.objectContaining({ truncated: true, artifact: expect.any(String) }));
    expect(record.links.artifact).toBe(record.payload.artifact);

    const artifactPath = path.join(rootDir, 'sess-1', record.links.artifact);
    expect(fs.existsSync(artifactPath)).toBe(true);
    const artifactPayload = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    expect(artifactPayload.api_key).not.toBe('supersecret');
    expect(artifactPayload.Authorization).not.toContain('abcdef123456');
    expect(artifactPayload.url).toContain('token=abc1');
    expect(artifactPayload.url).toContain('&safe=yes');
  });

  it('preserves every reserved correlation field across spill sizes', async () => {
    const recorder = new SessionTraceRecorder({
      rootDir,
      inlineLimit: 128,
      compressOverBytes: 1_000_000,
    });
    await recorder.init('sess-correlation', seed);
    for (const [index, size] of [129, 4_096, 65_536].entries()) {
      const receipt = await recorder.write('sess-correlation', index + 1, {
        event: 'tool.finish',
        payload: {
          requestId: `request-${index}`,
          toolCallId: `call-${index}`,
          name: 'neutral_marker',
          status: 'completed',
          outcome: 'success',
          detail: 'x'.repeat(size),
        },
      });
      expect(receipt.accepted).toBe(true);
    }
    await recorder.close('sess-correlation', { terminal: 'session.done', status: 'completed' });

    const records = fs.readFileSync(path.join(rootDir, 'sess-correlation', 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.event === 'tool.finish');
    expect(records).toHaveLength(3);
    for (const [index, record] of records.entries()) {
      expect(record).toMatchObject({
        schemaVersion: 3,
        eventId: expect.any(String),
        event: 'tool.finish',
        sessionId: 'sess-correlation',
        requestId: `request-${index}`,
        toolCallId: `call-${index}`,
        name: 'neutral_marker',
        status: 'completed',
        outcome: 'success',
        artifactRef: expect.stringMatching(/^artifacts\//u),
        artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    }
  });
});
