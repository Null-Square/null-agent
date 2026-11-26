import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
/**
 * Report durability contract (no runtime code changes).
 *
 * Validates ArtifactService.ensureReportForCompletion:
 * - Passes when report.md exists in durable storage (S3 mocked)
 * - Throws CompletionBlockedError (report_missing_in_s3) when genuinely missing
 * - Throws CompletionBlockedError (s3_unavailable) when S3 infra fails
 *
 * Uses in-memory SessionStore + mocked S3 client. Does not touch the real filesystem or DB.
 */

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import { CompletionBlockedError } from '@/domains/agent-brain/domain/errors';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

type FakeS3Client = {
  objectExistsWithReason: Mock;
};

describe('ArtifactService report durability', () => {
  let store: SessionStore;
  let artifactService: ArtifactService;
  let s3Client: FakeS3Client;
  let sessionId: string;

  beforeEach(async () => {
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    s3Client = { objectExistsWithReason: vi.fn() };
    artifactService = new ArtifactService(
      store,
      undefined,
      undefined,
      { bucket: 'test-bucket', client: s3Client as any },
    );

    const session = await store.create({ userId: 'user-1', mode: 'automated', modelName: 'test-model' });
    sessionId = session.id;

    // Seed a report artifact that points to S3
    session.artifacts = [
      {
        id: 'a1',
        filePath: 's3://test-bucket/sessions/report.md',
        originalName: 'report.md',
        fileType: 'md',
        sizeBytes: 10,
        createdAt: Date.now(),
        storage: 's3',
        bucket: 'test-bucket',
      },
    ] as any;
    store.set(sessionId, session);
  });

  it('passes when report exists in S3', async () => {
    s3Client.objectExistsWithReason.mockResolvedValueOnce({ exists: true });

    await expect(artifactService.ensureReportForCompletion(sessionId)).resolves.toBeUndefined();
    expect(s3Client.objectExistsWithReason).toHaveBeenCalledWith('sessions/report.md');
  });

  it('throws CompletionBlockedError when report is missing in S3', async () => {
    s3Client.objectExistsWithReason.mockResolvedValueOnce({ exists: false, reason: 'not_found' });

    await expect(artifactService.ensureReportForCompletion(sessionId)).rejects.toMatchObject({
      reason: 'report_missing_in_s3',
      retryable: false,
    } satisfies Partial<CompletionBlockedError>);
  });

  it('throws CompletionBlockedError when S3 is unavailable (retryable)', async () => {
    const infraError = new Error('s3 down');
    s3Client.objectExistsWithReason.mockResolvedValueOnce({ exists: false, reason: 's3_error', error: infraError });

    await expect(artifactService.ensureReportForCompletion(sessionId)).rejects.toMatchObject({
      reason: 's3_unavailable',
      retryable: true,
    } satisfies Partial<CompletionBlockedError>);
  });
});






