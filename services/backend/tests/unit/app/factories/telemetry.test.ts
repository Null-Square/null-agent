import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConfig } from '@/config/configTypes';
const mocks = vi.hoisted(() => ({
  recorderCtor: vi.fn(),
}));

let createTraceRetention: typeof import('@/app/factories/telemetry').createTraceRetention;
let createTraceRecorder: typeof import('@/app/factories/telemetry').createTraceRecorder;

describe('telemetry factories', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/domains/agent-brain/infrastructure/telemetry', () => ({
      SessionTraceRecorder: vi.fn().mockImplementation((options, s3, repo) => {
        mocks.recorderCtor(options, s3, repo);
        return { options, s3, repo };
      }),
      TraceRetentionService: vi.fn().mockImplementation(() => ({
        cleanup: vi.fn(),
      })),
    }));
    ({ createTraceRetention, createTraceRecorder } = await import('@/app/factories/telemetry'));
    vi.clearAllMocks();
  });

  it('returns undefined retention when traces are not in S3', () => {
    const config = {
      trace: { traceRetentionDays: 7 },
    } as ResolvedConfig;
    const retention = createTraceRetention(
      config,
      {
        s3TracesClient: undefined,
        s3TracesBucket: 'traces',
        s3Client: undefined,
        s3ArtifactsBucket: 'artifacts',
        s3WorkspacesBucket: 'workspaces',
      },
      {} as any,
    );

    expect(retention).toBeUndefined();
  });

  it('creates retention service when S3 traces are enabled', () => {
    const config = {
      trace: { traceRetentionDays: 7 },
    } as ResolvedConfig;
    const retention = createTraceRetention(
      config,
      {
        s3TracesClient: {} as any,
        s3TracesBucket: 'traces',
        s3Client: undefined,
        s3ArtifactsBucket: 'artifacts',
        s3WorkspacesBucket: 'workspaces',
      },
      {} as any,
    );

    expect(retention).toBeDefined();
    expect(typeof retention?.cleanup).toBe('function');
  });

  it('passes config and S3 bundle into the trace recorder', () => {
    const config = {
      trace: {
        traceLogsRoot: '/tmp/traces',
        traceInlineLimit: 1024,
        stdoutChunkSize: 2048,
        traceCompressOverBytes: 4096,
        traceRetentionDays: 14,
        s3FlushIntervalMs: 1234,
        s3FlushMaxEvents: 12,
      },
    } as ResolvedConfig;

    createTraceRecorder(
      config,
      {
        s3TracesClient: { name: 's3' } as any,
        s3TracesBucket: 'traces',
        s3Client: undefined,
        s3ArtifactsBucket: 'artifacts',
        s3WorkspacesBucket: 'workspaces',
      },
      {} as any,
    );

    expect(mocks.recorderCtor).toHaveBeenCalledWith(
      {
        rootDir: '/tmp/traces',
        inlineLimit: 1024,
        stdoutChunkSize: 2048,
        compressOverBytes: 4096,
        retentionDays: 14,
        s3FlushIntervalMs: 1234,
        s3FlushMaxEvents: 12,
      },
      { client: { name: 's3' }, bucket: 'traces' },
      {},
    );
  });
});
