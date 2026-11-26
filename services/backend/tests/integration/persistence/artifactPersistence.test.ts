import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb } from '../../helpers/testDb';
import { insertAgentSession } from '../../helpers/agentSessionDb';
import { ArtifactRepository } from '@/domains/agent-brain/adapters/persistence/ArtifactRepository';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';
import { S3StorageService } from '@/shared/storage/S3StorageService';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const s3Endpoint = process.env.TEST_S3_ENDPOINT;
const s3AccessKey = process.env.TEST_S3_ACCESS_KEY;
const s3SecretKey = process.env.TEST_S3_SECRET_KEY;

const canRunS3 = Boolean(s3Endpoint && s3AccessKey && s3SecretKey);
const maybeDescribe =
  canRunS3 && process.env.TEST_DATABASE_URL ? describe : describe.skip;

maybeDescribe('Artifact persistence (integration)', () => {
  let harness: Awaited<ReturnType<typeof setupTestDb>> | undefined;
  let artifactRepository: ArtifactRepository;
  let s3Client: S3StorageService;
  let testBucket: string;
  let skip = false;

  beforeAll(async () => {
    harness = await setupTestDb();
    if (!harness) {
      skip = true;
      return;
    }

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
    artifactRepository = new ArtifactRepository(harness.db);
  });

  afterAll(async () => {
    if (canRunS3 && s3Client && !process.env.TEST_S3_ARTIFACTS_BUCKET) {
      try {
        await s3Client.deletePrefix('');
      } catch {
        // ignore cleanup errors
      }
    }
    await harness?.dispose();
  });

  beforeEach(async () => {
    if (skip || !harness) return;
    await harness.truncateAll();
    await harness.pool.query('DELETE FROM agent_artifacts;');
  });

  const itMaybe = (name: string, fn: () => Promise<void>) =>
    it(name, async () => {
      if (skip) return;
      await fn();
    });

  itMaybe('uploads artifacts to S3 and persists metadata', async () => {
    if (!harness) return;
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-root-'));
    const userId = randomUUID();
    const sessionStore = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    const session = await sessionStore.create({ userId, mode: 'automated', modelName: 'test-model' });

    try {
      await insertAgentSession(harness.db, {
        id: session.id,
        userId,
        mode: 'automated',
        workspaceDir: session.workspaceDir,
      });

      fs.writeFileSync(path.join(session.workspaceDir, 'summary.md'), '# Summary');
      fs.writeFileSync(path.join(session.workspaceDir, 'report.md'), '# Report');

      const service = new ArtifactService(
        sessionStore,
        artifactRepository,
        storageRoot,
        { bucket: testBucket, client: s3Client },
      );

      await service.saveArtifacts(session);

      const records = await artifactRepository.listBySession(session.id);
      const names = records.map((row) => row.originalName);
      expect(names).toEqual(expect.arrayContaining(['summary.md', 'report.md']));
      for (const record of records) {
        expect(record.filePath.startsWith('s3://')).toBe(true);
      }

      const reportKey = s3Client.makeKey(session.id, 'report.md');
      const exists = await s3Client.objectExistsWithReason(reportKey);
      expect(exists.exists).toBe(true);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
      fs.rmSync(session.workspaceDir, { recursive: true, force: true });
    }
  });
});
