import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { toSafeError } from '@/shared/errors';

const getS3ErrorMetadata = (error: unknown): { name?: string; status?: number } => {
  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    status: record.$metadata?.httpStatusCode,
  };
};

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  typeof value === 'object' && value !== null && Symbol.asyncIterator in value;

const isBlobLike = (value: unknown): value is { arrayBuffer: () => Promise<ArrayBuffer> } => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as { arrayBuffer?: unknown };
  return typeof record.arrayBuffer === 'function';
};

export type S3StorageConfig = {
  endpoint: string;
  publicEndpoint?: string; // Browser-accessible endpoint for presigned URLs
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  autoCreateBucket?: boolean;
  bucket: string;
  metricsLabel?: 'artifacts' | 'traces';
};

export type S3HealthStatus = {
  ok: boolean;
  ms: number;
  error?: string;
};

export class S3StorageService {
  private client: S3Client;
  private publicClient?: S3Client; // Client using public endpoint for presigned URLs
  private bucket: string;
  private metricsLabel?: 'artifacts' | 'traces';
  private autoCreateBucket: boolean;

  constructor(config: S3StorageConfig) {
    const clientConfig: S3ClientConfig = {
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    };
    (clientConfig as S3ClientConfig & { requestChecksumCalculation?: 'WHEN_REQUIRED' }).requestChecksumCalculation =
      'WHEN_REQUIRED';
    this.client = new S3Client(clientConfig);
    this.bucket = config.bucket;
    this.metricsLabel = config.metricsLabel;
    this.autoCreateBucket = config.autoCreateBucket ?? true;

    // Create a separate client with public endpoint for presigned URLs
    if (config.publicEndpoint && config.publicEndpoint !== config.endpoint) {
      this.publicClient = new S3Client({
        ...clientConfig,
        endpoint: config.publicEndpoint,
      });
    }
  }

  getBucket(): string {
    return this.bucket;
  }

  async checkHealth(): Promise<S3HealthStatus> {
    const start = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'head');
      return { ok: true, ms: Date.now() - start };
    } catch (error: unknown) {
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'head_error');
      const { name, status } = getS3ErrorMetadata(error);
      const message = toSafeError(error).message;
      const detail = [name, status ? `status=${status}` : undefined].filter(Boolean).join(' ');
      return { ok: false, ms: Date.now() - start, error: detail ? `${detail}: ${message}` : message };
    }
  }

  async ensureBucket(): Promise<void> {
    const start = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'head');
    } catch (error) {
      if (!this.autoCreateBucket) {
        throw error;
      }
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (createError) {
        // Two clients of one bucket start together: the other one created it first.
        if (getS3ErrorMetadata(createError).name !== 'BucketAlreadyOwnedByYou') {
          throw createError;
        }
      }
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'create');
    }
  }

  async uploadFileFromPath(key: string, filePath: string, contentType?: string): Promise<void> {
    const start = Date.now();
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`S3 upload source is not a file: ${filePath}`);
    }
    const contentLength = Number(stats.size);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error(`S3 upload source has invalid size: ${filePath}`);
    }
    const body = fs.createReadStream(filePath);
    body.once('error', () => {
      // The AWS SDK also observes stream errors. This listener prevents a late
      // filesystem open error from becoming an unhandled process-level event.
    });
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
      );
    } catch (error) {
      body.destroy();
      throw error;
    }
    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'put');
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType?: string): Promise<void> {
    const start = Date.now();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
      }),
    );
    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'put');
  }

  async getPresignedUrl(key: string, expiresInSeconds: number = 300): Promise<string> {
    const start = Date.now();
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    // Use public client for browser-accessible URLs if available
    const client = this.publicClient ?? this.client;
    const url = await getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'presign');
    return url;
  }

  async getObjectBuffer(key: string): Promise<Buffer> {
    const start = Date.now();
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Uint8Array[] = [];
    const body = res.Body;
    if (!body) {
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'get');
      return Buffer.alloc(0);
    }

    if (body instanceof Readable || isAsyncIterable(body)) {
      for await (const chunk of body) {
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'get');
      return buf;
    }

    if (isBlobLike(body)) {
      const arrayBuffer = await body.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'get');
      return buf;
    }

    throw new Error('Unsupported S3 response body type');
  }

  /**
   * Check if an object exists in the bucket.
   * PHASE 4: Used for durable artifact validation before marking task complete.
   */
  async objectExists(key: string): Promise<boolean> {
    const result = await this.objectExistsWithReason(key);
    if (result.exists) return true;
    if (result.reason === 'not_found') return false;
    throw result.error; // Re-throw infra errors
  }

  /**
   * Check if an object exists with structured result distinguishing:
   * - exists: true → object found
   * - exists: false, reason: 'not_found' → 404/NoSuchKey (genuine missing)
   * - exists: false, reason: 's3_error' → infra failure (should retry)
   * 
   * HARDENING: Per GPT 5.2 feedback - infra failures should not be treated as "missing".
   */
  async objectExistsWithReason(key: string): Promise<
    | { exists: true }
    | { exists: false; reason: 'not_found' }
    | { exists: false; reason: 's3_error'; error: Error }
  > {
    const start = Date.now();
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'head');
      return { exists: true };
    } catch (error: unknown) {
      // 404 / NoSuchKey = genuinely not found
      const { name, status } = getS3ErrorMetadata(error);
      if (
        name === 'NotFound' ||
        name === 'NoSuchKey' ||
        status === 404
      ) {
        return { exists: false, reason: 'not_found' };
      }
      
      // Any other error = infra failure (403, timeout, DNS, etc.)
      return { exists: false, reason: 's3_error', error: toSafeError(error) };
    }
  }

  async deleteObject(key: string): Promise<void> {
    const start = Date.now();
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'delete');
  }

  async deletePrefix(prefix: string): Promise<void> {
    const start = Date.now();
    let continuationToken: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const contents = list.Contents ?? [];
      for (const obj of contents) {
        if (obj.Key) {
          await this.deleteObject(obj.Key);
        }
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'deletePrefix');
  }

  /**
   * List all objects with the given prefix.
   * Returns both the full key and the relative path (key minus prefix).
   */
  async listPrefix(prefix: string): Promise<{ key: string; relativePath: string }[]> {
    const start = Date.now();
    const results: { key: string; relativePath: string }[] = [];
    let continuationToken: string | undefined;

    do {
      const list = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of list.Contents ?? []) {
        if (obj.Key) {
          results.push({
            key: obj.Key,
            relativePath: obj.Key.slice(prefix.length),
          });
        }
      }
      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    opsMetrics.recordS3(this.metricsLabel ?? 'artifacts', Date.now() - start, 'list');
    return results;
  }

  makeKey(...parts: string[]): string {
    return parts
      .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
      .filter(Boolean)
      .join('/');
  }

  resolveLocalKey(root: string, absolutePath: string): string {
    const normalizedRoot = root.replace(/\\/g, '/');
    const normalizedAbsolute = absolutePath.replace(/\\/g, '/');
    const relative = path.posix.relative(normalizedRoot, normalizedAbsolute);
    return relative.replace(/^\/+/, '');
  }
}
