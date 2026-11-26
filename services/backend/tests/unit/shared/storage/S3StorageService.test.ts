import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import {
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import fs from 'fs';
import os from 'os';
import path from 'path';
const mocks = vi.hoisted(() => ({
  recordS3: vi.fn(),
  getSignedUrl: vi.fn().mockResolvedValue('https://signed'),
}));

vi.mock('@/shared/metrics/opsMetrics', () => ({
  opsMetrics: {
    recordS3: mocks.recordS3,
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

let StorageService: typeof import('@/shared/storage/S3StorageService').S3StorageService;

const config = {
  endpoint: 'http://s3.local',
  region: 'us-east-1',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'bucket-1',
  metricsLabel: 'artifacts' as const,
};

describe('S3StorageService', () => {
  beforeAll(async () => {
    const mod = await import('@/shared/storage/S3StorageService');
    StorageService = mod.S3StorageService;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSignedUrl.mockResolvedValue('https://signed');
  });

  it('reports health when head succeeds', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockResolvedValue({});
    (service as any).client = { send };

    const status = await service.checkHealth();

    expect(status.ok).toBe(true);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(mocks.recordS3).toHaveBeenCalledWith('artifacts', expect.any(Number), 'head');
  });

  it('reports health errors with status details', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockRejectedValue({
      name: 'Forbidden',
      message: 'nope',
      $metadata: { httpStatusCode: 403 },
    });
    (service as any).client = { send };

    const status = await service.checkHealth();

    expect(status.ok).toBe(false);
    expect(status.error).toContain('Forbidden');
    expect(status.error).toContain('status=403');
    expect(mocks.recordS3).toHaveBeenCalledWith('artifacts', expect.any(Number), 'head_error');
  });

  it('creates bucket when head fails', async () => {
    const service = new StorageService(config);
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({});
    (service as any).client = { send };

    await service.ensureBucket();

    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('treats a bucket another client just created as ready', async () => {
    const service = new StorageService({ ...config, autoCreateBucket: true });
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound' }))
      .mockRejectedValueOnce(Object.assign(new Error('owned'), { name: 'BucketAlreadyOwnedByYou' }));
    (service as any).client = { send };

    await expect(service.ensureBucket()).resolves.toBeUndefined();
    expect(send.mock.calls[1][0]).toBeInstanceOf(CreateBucketCommand);
  });

  it('still fails when creating the bucket fails for another reason', async () => {
    const service = new StorageService({ ...config, autoCreateBucket: true });
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound' }))
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    (service as any).client = { send };

    await expect(service.ensureBucket()).rejects.toThrow('denied');
  });

  it('does not create bucket when auto create is disabled', async () => {
    const service = new StorageService({ ...config, autoCreateBucket: false });
    const error = new Error('missing');
    const send = vi.fn().mockRejectedValue(error);
    (service as any).client = { send };

    await expect(service.ensureBucket()).rejects.toThrow('missing');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
  });

  it('uploads buffers and records metrics', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockResolvedValue({});
    (service as any).client = { send };

    await service.uploadBuffer('key', Buffer.from('data'), 'text/plain');

    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect((cmd as any).input).toEqual(expect.objectContaining({
      Bucket: 'bucket-1',
      Key: 'key',
      ContentLength: 4,
    }));
    expect(mocks.recordS3).toHaveBeenCalledWith('artifacts', expect.any(Number), 'put');
  });

  it('uploads file paths with a concrete content length', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-storage-'));
    const filePath = path.join(tempDir, 'artifact.txt');
    fs.writeFileSync(filePath, 'hello');
    const service = new StorageService(config);
    const send = vi.fn().mockResolvedValue({});
    (service as any).client = { send };

    try {
      await service.uploadFileFromPath('artifact.txt', filePath, 'text/plain');

      const cmd = send.mock.calls[0][0] as PutObjectCommand;
      expect(cmd).toBeInstanceOf(PutObjectCommand);
      expect((cmd as any).input).toEqual(expect.objectContaining({
        Bucket: 'bucket-1',
        Key: 'artifact.txt',
        ContentType: 'text/plain',
        ContentLength: 5,
      }));
      (cmd as any).input.Body.destroy();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not create an upload stream when the file is missing', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockResolvedValue({});
    (service as any).client = { send };

    await expect(service.uploadFileFromPath('missing.txt', path.join(os.tmpdir(), 'missing-artifact.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('generates presigned urls', async () => {
    const service = new StorageService(config);
    const send = vi.fn();
    (service as any).client = { send };

    const url = await service.getPresignedUrl('file.txt', 60);

    expect(mocks.getSignedUrl).toHaveBeenCalledWith(
      (service as any).client,
      expect.any(GetObjectCommand),
      { expiresIn: 60 },
    );
    expect(url).toBe('https://signed');
    expect(mocks.recordS3).toHaveBeenCalledWith('artifacts', expect.any(Number), 'presign');
  });

  it('reads object buffers from streams', async () => {
    const service = new StorageService(config);
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('a');
        yield Buffer.from('b');
      },
    };
    const send = vi.fn().mockResolvedValue({ Body: stream });
    (service as any).client = { send };

    const buffer = await service.getObjectBuffer('obj');

    expect(buffer.toString('utf8')).toBe('ab');
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });

  it('distinguishes missing objects from infra errors', async () => {
    const service = new StorageService(config);
    const send = vi.fn()
      .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      .mockRejectedValueOnce(new Error('boom'));
    (service as any).client = { send };

    await expect(service.objectExistsWithReason('missing')).resolves.toEqual({
      exists: false,
      reason: 'not_found',
    });

    const result = await service.objectExistsWithReason('boom');
    if (result.exists) {
      throw new Error('Expected missing object result');
    }
    expect(result.reason).toBe('s3_error');
    expect(result).toHaveProperty('error');
  });

  it('throws for infra errors in objectExists', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockRejectedValue(new Error('boom'));
    (service as any).client = { send };

    await expect(service.objectExists('oops')).rejects.toThrow('boom');
  });

  it('deletes objects by prefix', async () => {
    const service = new StorageService(config);
    const deleted: string[] = [];
    const send = vi.fn().mockImplementation((cmd: any) => {
      if (cmd instanceof ListObjectsV2Command) {
        return Promise.resolve({
          Contents: [{ Key: 'prefix/a' }, { Key: 'prefix/b' }],
          IsTruncated: false,
        });
      }
      if (cmd instanceof DeleteObjectCommand) {
        if (cmd.input.Key) {
          deleted.push(cmd.input.Key);
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    (service as any).client = { send };

    await service.deletePrefix('prefix/');

    expect(deleted).toEqual(['prefix/a', 'prefix/b']);
  });

  it('lists objects by prefix across pages', async () => {
    const service = new StorageService(config);
    const send = vi.fn().mockImplementation((cmd: any) => {
      if (cmd instanceof ListObjectsV2Command) {
        const token = cmd.input.ContinuationToken;
        if (!token) {
          return Promise.resolve({
            Contents: [{ Key: 'prefix/a' }],
            IsTruncated: true,
            NextContinuationToken: 'next',
          });
        }
        return Promise.resolve({
          Contents: [{ Key: 'prefix/b' }],
          IsTruncated: false,
        });
      }
      return Promise.resolve({});
    });
    (service as any).client = { send };

    const results = await service.listPrefix('prefix/');

    expect(results).toEqual([
      { key: 'prefix/a', relativePath: 'a' },
      { key: 'prefix/b', relativePath: 'b' },
    ]);
  });

  it('normalizes keys and resolves relative paths', () => {
    const service = new StorageService(config);

    expect(service.makeKey('/root/', '/child', 'file.txt')).toBe('root/child/file.txt');
    expect(service.resolveLocalKey('C:\\root', 'C:\\root\\sub\\file.txt')).toBe('sub/file.txt');
  });
});
