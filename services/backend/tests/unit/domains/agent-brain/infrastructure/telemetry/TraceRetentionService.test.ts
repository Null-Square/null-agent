import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraceRetentionService } from '@/domains/agent-brain/infrastructure/telemetry';
import { opsMetrics } from '@/shared/metrics/opsMetrics';

describe('TraceRetentionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when S3 is not configured', async () => {
    const repo = { list: vi.fn() } as any;
    const service = new TraceRetentionService(repo);

    await service.cleanup();

    expect(repo.list).not.toHaveBeenCalled();
  });

  it('deletes expired trace objects and records metrics', async () => {
    const now = Date.now();
    const repo = {
      list: vi.fn().mockResolvedValue([
        {
          traceKey: 'trace-old.ndjson',
          markdownKey: 'trace-old.md',
          costKey: 'cost-old.md',
          artifactsPrefix: 'artifacts/old/',
          updatedAt: new Date(now - 20 * 24 * 60 * 60 * 1000),
        },
        {
          traceKey: 'trace-new.ndjson',
          markdownKey: 'trace-new.md',
          costKey: 'cost-new.md',
          artifactsPrefix: 'artifacts/new/',
          updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
        },
      ]),
    } as any;
    const s3 = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
      deletePrefix: vi.fn().mockResolvedValue(undefined),
    } as any;
    const recordRetention = vi.spyOn(opsMetrics, 'recordRetention').mockImplementation(() => undefined);
    const service = new TraceRetentionService(repo, s3, 14);

    await service.cleanup();

    expect(s3.deleteObject).toHaveBeenCalledWith('trace-old.ndjson');
    expect(s3.deleteObject).toHaveBeenCalledWith('trace-old.md');
    expect(s3.deleteObject).toHaveBeenCalledWith('cost-old.md');
    expect(s3.deletePrefix).toHaveBeenCalledWith('artifacts/old/');
    expect(s3.deleteObject).not.toHaveBeenCalledWith('trace-new.ndjson');
    expect(recordRetention).toHaveBeenCalledWith(expect.any(Number), 1, 'ok');
  });

  it('records error metrics and rethrows on failure', async () => {
    const repo = {
      list: vi.fn().mockRejectedValue(new Error('boom')),
    } as any;
    const s3 = {
      deleteObject: vi.fn(),
      deletePrefix: vi.fn(),
    } as any;
    const recordRetention = vi.spyOn(opsMetrics, 'recordRetention').mockImplementation(() => undefined);
    const service = new TraceRetentionService(repo, s3, 14);

    await expect(service.cleanup()).rejects.toThrow('boom');
    expect(recordRetention).toHaveBeenCalledWith(expect.any(Number), 0, 'error');
  });
});
