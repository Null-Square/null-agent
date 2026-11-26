import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
/**
 * S3/Artifact Completion Gate Integration Tests
 *
 * Requires TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY, TEST_S3_SECRET_KEY pointing to a test MinIO/S3.
 * Skips automatically if env is not set (to keep PR runs green).
 * 
 * Tests the completion validation contract per GPT 5.2 feedback:
 * - Missing artifact blocks completion (NOT retryable)
 * - S3 infra error triggers retryable CompletionBlockedError
 */

import { v4 as uuidv4 } from 'uuid';
import { S3StorageService } from '@/shared/storage/S3StorageService';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { CompletionBlockedError } from '@/domains/agent-brain/domain/errors';
import { SessionState } from '@/domains/agent-brain/domain/types';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

const s3Endpoint = process.env.TEST_S3_ENDPOINT;
const s3AccessKey = process.env.TEST_S3_ACCESS_KEY;
const s3SecretKey = process.env.TEST_S3_SECRET_KEY;

const canRunS3Tests = Boolean(s3Endpoint && s3AccessKey && s3SecretKey);
const maybeDescribe = canRunS3Tests ? describe : describe.skip;

maybeDescribe('S3 Completion Gate', () => {
  let s3Client: S3StorageService;
  let testBucket: string;

  beforeAll(async () => {
    // Use CI bucket if set, otherwise create a dynamic one
    testBucket = process.env.TEST_S3_ARTIFACTS_BUCKET || `test-artifacts-${Date.now()}`;
    s3Client = new S3StorageService({
      endpoint: s3Endpoint!,
      region: 'us-east-1',
      accessKeyId: s3AccessKey!,
      secretAccessKey: s3SecretKey!,
      forcePathStyle: true,
      bucket: testBucket,
    });
    await s3Client.ensureBucket();
  });

  afterAll(async () => {
    // Clean up test bucket (only if we created it dynamically)
    if (!process.env.TEST_S3_ARTIFACTS_BUCKET) {
      try {
        await s3Client.deletePrefix('');
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('objectExistsWithReason', () => {
    it('returns exists: true for existing object', async () => {
      const key = `test-${uuidv4()}/report.md`;
      await s3Client.uploadBuffer(key, Buffer.from('# Test Report'));

      const result = await s3Client.objectExistsWithReason(key);
      expect(result.exists).toBe(true);
    });

    it('returns not_found for missing object', async () => {
      const key = `nonexistent-${uuidv4()}/report.md`;

      const result = await s3Client.objectExistsWithReason(key);
      expect(result.exists).toBe(false);
      if (!result.exists) {
        expect(result.reason).toBe('not_found');
      }
    });
  });

  describe('ArtifactService.ensureReportForCompletion', () => {
    let sessionStore: SessionStore;
    let artifactService: ArtifactService;
    let testSessionId: string;

    beforeEach(() => {
      sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
      artifactService = new ArtifactService(
        sessionStore,
        undefined,
        undefined,
        { bucket: testBucket, client: s3Client },
      );
      testSessionId = uuidv4();
    });

    it('throws non-retryable CompletionBlockedError when report.md is missing', async () => {
      // Create session with no artifacts
      const createdSession = await sessionStore.create({ userId: 'test', modelName: 'test-model' });
      testSessionId = createdSession.id;
      sessionStore.set(testSessionId, {
        ...createdSession,
        artifacts: [], // No artifacts
      });

      await expect(
        artifactService.ensureReportForCompletion(testSessionId)
      ).rejects.toThrow(CompletionBlockedError);

      try {
        await artifactService.ensureReportForCompletion(testSessionId);
      } catch (error) {
        expect(error).toBeInstanceOf(CompletionBlockedError);
        const cbError = error as CompletionBlockedError;
        expect(cbError.reason).toBe('report_missing_in_s3');
        expect(cbError.retryable).toBe(false);
      }
    });

    it('succeeds when report.md exists in S3', async () => {
      // Create session with artifact pointing to S3
      const createdSession = await sessionStore.create({ userId: 'test', modelName: 'test-model' });
      testSessionId = createdSession.id;

      const reportKey = s3Client.makeKey(testSessionId, 'report.md');
      
      await s3Client.uploadBuffer(reportKey, Buffer.from('# Final Report\n\nTask complete.'));
      
      // Verify upload worked
      const uploadCheck = await s3Client.objectExistsWithReason(reportKey);
      expect(uploadCheck.exists).toBe(true);
      
      const filePath = `s3://${testBucket}/${reportKey}`;
      
      // FIX: Get fresh session reference to avoid version conflict,
      // then mutate artifacts directly instead of using set() with stale version
      const session = sessionStore.get(testSessionId);
      expect(session).toBeDefined();
      session!.artifacts = [{
        id: `${testSessionId}-report`,
        filePath,
        originalName: 'report.md',
        fileType: 'md',
        sizeBytes: 100,
        createdAt: Date.now(),
        storage: 's3',
        bucket: testBucket,
      }];

      // Should not throw
      await expect(
        artifactService.ensureReportForCompletion(testSessionId)
      ).resolves.not.toThrow();
    });
  });
});

describe('CompletionBlockedError', () => {
  it('is retryable for s3_unavailable', () => {
    const error = new CompletionBlockedError({
      reason: 's3_unavailable',
      sessionId: 'test-session',
    });
    expect(error.retryable).toBe(true);
    expect(error.reason).toBe('s3_unavailable');
  });

  it('is NOT retryable for report_missing_in_s3', () => {
    const error = new CompletionBlockedError({
      reason: 'report_missing_in_s3',
      sessionId: 'test-session',
    });
    expect(error.retryable).toBe(false);
    expect(error.reason).toBe('report_missing_in_s3');
  });

  it('serializes to JSON correctly', () => {
    const error = new CompletionBlockedError({
      reason: 'report_missing_in_s3',
      sessionId: 'session-123',
      artifactName: 'report.md',
      message: 'Custom message',
    });
    
    const json = error.toJSON();
    expect(json.name).toBe('CompletionBlockedError');
    expect(json.reason).toBe('report_missing_in_s3');
    expect(json.retryable).toBe(false);
    expect(json.sessionId).toBe('session-123');
    expect(json.artifactName).toBe('report.md');
  });
});






