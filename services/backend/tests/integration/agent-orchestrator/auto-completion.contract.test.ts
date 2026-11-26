import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
/**
 * Auto-completion contract (mocked, no runtime changes).
 *
 * Simulates the Orchestrator completion path:
 * - ensureReportForCompletion must pass before "done" is allowed.
 * - Missing report or S3 error -> guard fires, suppresses done, schedules retry.
 *
 * Uses:
 * - ArtifactService with mocked S3 client (no filesystem/DB).
 * - AutomationGuardHandler + AutomationModePolicy (real implementations).
 */

import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { ArtifactService } from '@/domains/agent-brain/infrastructure/artifacts/ArtifactService';
import { CompletionBlockedError } from '@/domains/agent-brain/domain/errors';
import { AutomationGuardHandler } from '@/domains/agent-brain/application/orchestration/services/AutomationGuardHandler';
import AutomationModePolicy from '@/domains/agent-brain/application/services/AutomationModePolicy';
import { createTestWorkspaceManager } from '@/shared/testing/workspaceManager';

type FakeS3Client = {
  objectExistsWithReason: Mock;
};

describe('Auto-completion contract (report required before done)', () => {
  let store: SessionStore;
  let artifactService: ArtifactService;
  let guard: AutomationGuardHandler;
  let s3Client: FakeS3Client;
  let sessionId: string;
  const turnStream = { raw: vi.fn(), done: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    store = new SessionStore({ workspaceManager: createTestWorkspaceManager() });
    s3Client = { objectExistsWithReason: vi.fn() };
    artifactService = new ArtifactService(
      store,
      undefined,
      undefined,
      { bucket: 'test-bucket', client: s3Client as any },
    );
    guard = new AutomationGuardHandler({
      sessionStore: store as any,
      automationPolicy: new AutomationModePolicy({ requireReport: true }),
    });

    const session = await store.create({ userId: 'u-auto', mode: 'automated', modelName: 'test-model' });
    sessionId = session.id;
    // Seed report artifact pointing to S3
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
    // Use stateMachine as source of truth for processing state
    session.stateMachine?.startProcessing('test', 1, 'test');
    store.set(sessionId, session);
  });

  const runCompletionSimulation = async () => {
    let hasReport = true;
    try {
      await artifactService.ensureReportForCompletion(sessionId);
    } catch (err) {
      if (err instanceof CompletionBlockedError) {
        hasReport = false; // orchestrator would suppress completion on validation failure
      } else {
        throw err;
      }
    }

    return guard.handle({
      sessionId,
      turnNumber: 1,
      session: store.get(sessionId)!,
      pendingPlanSteps: [],
      hasReport,
      toolCallCount: 1,
      turnStatus: 'completed',
      turnStream,
      recorder: undefined,
    });
  };

  it('allows completion when report validated in S3', async () => {
    s3Client.objectExistsWithReason.mockResolvedValueOnce({ exists: true });

    const result = await runCompletionSimulation();

    expect(result.suppressDone).toBe(false);
    expect(result.modeSwitchReason).toBe('automated.completed');
    expect(turnStream.raw).not.toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'automated_guard' }),
    );
  });

  it('suppresses done and schedules retry when report is missing in S3', async () => {
    s3Client.objectExistsWithReason.mockResolvedValueOnce({ exists: false, reason: 'not_found' });

    const result = await runCompletionSimulation();

    expect(result.suppressDone).toBe(true);
    expect(result.scheduleAutoRetry).toBe(true);
    expect(result.modeSwitchReason).toBeUndefined();
    expect(turnStream.raw).toHaveBeenCalledWith(
      'warning',
      expect.objectContaining({ code: 'automated_guard' }),
    );
  });

  it('suppresses done when S3 is unavailable (retryable)', async () => {
    s3Client.objectExistsWithReason.mockResolvedValueOnce({
      exists: false,
      reason: 's3_error',
      error: new Error('s3 down'),
    });

    const result = await runCompletionSimulation();

    expect(result.suppressDone).toBe(true);
    expect(result.scheduleAutoRetry).toBe(true);
    expect(result.modeSwitchReason).toBeUndefined();
  });
});
