import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionTraceRecorder } from '@/domains/agent-brain/infrastructure/telemetry';

const seed = {
  workspace: '/tmp/ws',
  tools: ['tool-a'],
  model: 'gpt-test',
  profileKey: 'default',
};

describe('SessionTraceRecorder S3 persistence', () => {
  it('batches S3-only trace uploads until close when below flush thresholds', async () => {
    const s3Client = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new SessionTraceRecorder(
      {
        rootDir: path.join(os.tmpdir(), 'trace-s3-batched'),
        keepLocalCopy: false,
        s3FlushIntervalMs: 60_000,
        s3FlushMaxEvents: 100,
      },
      { client: s3Client as any, bucket: 'trace-bucket' },
    );

    await recorder.init('sess-batched', seed);
    await recorder.write('sess-batched', 1, { event: 'tool.run', severity: 'info', payload: { ok: true } });
    await recorder.write('sess-batched', 1, { event: 'tool.finish', severity: 'info', payload: { ok: true } });

    expect(s3Client.uploadBuffer).not.toHaveBeenCalledWith('sess-batched/trace.ndjson', expect.any(Buffer));
    expect(s3Client.uploadBuffer).not.toHaveBeenCalledWith('sess-batched/trace.md', expect.any(Buffer));

    await recorder.close('sess-batched', { terminal: 'session.done', status: 'completed', turns: 1 });

    const keys = (s3Client.uploadBuffer as any).mock.calls.map((call: any[]) => call[0]);
    expect(keys.filter((key: string) => key === 'sess-batched/trace.ndjson')).toHaveLength(1);
    expect(keys.filter((key: string) => key === 'sess-batched/trace.md')).toHaveLength(1);
    expect(keys).toEqual(expect.arrayContaining([
      'sess-batched/index.json',
      'sess-batched/.retention',
    ]));
    const indexCall = (s3Client.uploadBuffer as any).mock.calls.find(
      (call: any[]) => call[0] === 'sess-batched/index.json',
    );
    const index = JSON.parse(Buffer.from(indexCall[1]).toString('utf8'));
    expect(index.storage).toEqual(expect.objectContaining({
      s3TraceFlushes: 1,
      s3TraceObjectsUploaded: 2,
      s3TraceBytesUploaded: expect.any(Number),
    }));
    expect(index.storage.s3TraceBytesUploaded).toBeGreaterThan(0);
  });

  it('flushes an S3-only trace batch when the event threshold is reached', async () => {
    const s3Client = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new SessionTraceRecorder(
      {
        rootDir: path.join(os.tmpdir(), 'trace-s3-threshold'),
        keepLocalCopy: false,
        s3FlushIntervalMs: 60_000,
        s3FlushMaxEvents: 2,
      },
      { client: s3Client as any, bucket: 'trace-bucket' },
    );

    await recorder.init('sess-threshold', seed);
    await recorder.write('sess-threshold', 1, { event: 'tool.run', severity: 'info', payload: { ok: true } });

    let keys = (s3Client.uploadBuffer as any).mock.calls.map((call: any[]) => call[0]);
    expect(keys.filter((key: string) => key === 'sess-threshold/trace.ndjson')).toHaveLength(1);
    expect(keys.filter((key: string) => key === 'sess-threshold/trace.md')).toHaveLength(1);

    await recorder.close('sess-threshold', { terminal: 'session.done', status: 'completed', turns: 1 });

    keys = (s3Client.uploadBuffer as any).mock.calls.map((call: any[]) => call[0]);
    expect(keys.filter((key: string) => key === 'sess-threshold/trace.ndjson')).toHaveLength(1);
    expect(keys.filter((key: string) => key === 'sess-threshold/trace.md')).toHaveLength(1);
    expect(keys).toContain('sess-threshold/index.json');
    const indexCall = (s3Client.uploadBuffer as any).mock.calls.find(
      (call: any[]) => call[0] === 'sess-threshold/index.json',
    );
    const index = JSON.parse(Buffer.from(indexCall[1]).toString('utf8'));
    expect(index.storage).toEqual(expect.objectContaining({
      s3TraceFlushes: 1,
      s3TraceObjectsUploaded: 2,
      s3TraceBytesUploaded: expect.any(Number),
    }));
  });

  it('flushes traces to S3 and writes an index on close', async () => {
    const s3Client = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
    };
    const traceIndexRepo = { upsert: vi.fn().mockResolvedValue(undefined) };
    const recorder = new SessionTraceRecorder(
      { rootDir: path.join(os.tmpdir(), 'trace-s3'), keepLocalCopy: false },
      { client: s3Client as any, bucket: 'trace-bucket' },
      traceIndexRepo as any,
    );

    await recorder.init('sess-s3', seed);
    await recorder.write('sess-s3', 1, { event: 'tool.run', severity: 'info', payload: { ok: true } });
    await recorder.close('sess-s3', { terminal: 'session.done', status: 'completed', turns: 1 });

    const keys = (s3Client.uploadBuffer as any).mock.calls.map((call: any[]) => call[0]);
    expect(keys).toEqual(expect.arrayContaining([
      'sess-s3/trace.ndjson',
      'sess-s3/trace.md',
      'sess-s3/index.json',
      'sess-s3/.retention',
    ]));
    expect(traceIndexRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-s3',
        traceKey: 'sess-s3/trace.ndjson',
        markdownKey: 'sess-s3/trace.md',
        costKey: 'sess-s3/cost.md',
        artifactsPrefix: 'sess-s3/artifacts/',
      }),
    );
  });

  it('writes a trace index row when local trace files are retained without S3', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-local-index-'));
    const traceIndexRepo = { upsert: vi.fn().mockResolvedValue(undefined) };
    const recorder = new SessionTraceRecorder(
      { rootDir, keepLocalCopy: true },
      undefined,
      traceIndexRepo as any,
    );

    await recorder.init('sess-local-index', seed);
    await recorder.write('sess-local-index', 1, { event: 'tool.run', severity: 'info', payload: { ok: true } });
    await recorder.close('sess-local-index', { terminal: 'session.done', status: 'completed', turns: 1 });

    expect(fs.existsSync(path.join(rootDir, 'sess-local-index', 'trace.ndjson'))).toBe(true);
    expect(traceIndexRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-local-index',
        traceKey: 'sess-local-index/trace.ndjson',
        markdownKey: 'sess-local-index/trace.md',
        costKey: 'sess-local-index/cost.md',
        artifactsPrefix: 'sess-local-index/artifacts/',
      }),
    );

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('syncs workspace files to S3 and writes a manifest', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sync-'));
    const workspace = path.join(rootDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'hello');
    fs.mkdirSync(path.join(workspace, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'node_modules', 'skip.txt'), 'skip');
    fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1');

    const s3Client = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadFileFromPath: vi.fn().mockResolvedValue(undefined),
      uploadBuffer: vi.fn().mockResolvedValue(undefined),
    };

    const recorder = new SessionTraceRecorder(
      { rootDir, keepLocalCopy: true },
      { client: s3Client as any, bucket: 'trace-bucket' },
    );

    const result = await recorder.syncWorkspaceToS3('sess-ws', workspace);

    expect(result.success).toBe(true);
    expect(result.filesUploaded).toBe(1);
    expect(s3Client.uploadFileFromPath).toHaveBeenCalledWith(
      'workspaces/sess-ws/notes.txt',
      expect.stringContaining('notes.txt'),
    );
    expect(s3Client.uploadBuffer).toHaveBeenCalledWith(
      'workspaces/sess-ws/_manifest.json',
      expect.any(Buffer),
    );

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns a failure when S3 is not configured', async () => {
    const recorder = new SessionTraceRecorder({ rootDir: path.join(os.tmpdir(), 'trace-nos3') });
    const result = await recorder.syncWorkspaceToS3('sess-no', '/tmp/ws');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/S3 not configured/);
  });

  it('uploads local trace files when keepLocalCopy is enabled', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-local-'));
    const s3Client = {
      ensureBucket: vi.fn().mockResolvedValue(undefined),
      uploadFileFromPath: vi.fn().mockResolvedValue(undefined),
    };
    const recorder = new SessionTraceRecorder(
      { rootDir, keepLocalCopy: true },
      { client: s3Client as any, bucket: 'trace-bucket' },
    );

    await recorder.init('sess-local', seed);
    await recorder.write('sess-local', 1, { event: 'tool.run', severity: 'info', payload: { ok: true } });
    await recorder.close('sess-local', { terminal: 'session.done', status: 'completed', turns: 1 });

    const keys = (s3Client.uploadFileFromPath as any).mock.calls.map((call: any[]) => call[0]);
    expect(keys).toEqual(expect.arrayContaining([
      'sess-local/trace.ndjson',
      'sess-local/trace.md',
      'sess-local/index.json',
    ]));

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
