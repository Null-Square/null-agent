import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@/shared/logger', () => ({
  logger: {
    warn: loggerMocks.loggerWarn,
    info: loggerMocks.loggerInfo,
    error: loggerMocks.loggerError,
  },
}));

import { RunService } from '@/domains/security-ops/runs/RunService';

type DigestRow = {
  id: string;
  title?: string | null;
  data?: Record<string, unknown>;
  sessionId?: string | null;
};

type RunLike = {
  id: string;
  userId: string;
  organizationId: string;
  scopeId: string;
  goal: string;
  sessionId: string;
  plannerSessionId?: string | null;
  executorSessionId: string | null;
};

const buildDb = (existingDigests: DigestRow[] = []) => {
  const limitMock = vi.fn().mockResolvedValue(existingDigests);
  const whereMock = vi.fn(() => ({ limit: limitMock }));
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));

  const insertCalls: unknown[] = [];
  const insertMock = vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      insertCalls.push({ table, values });
      return Promise.resolve(undefined);
    }),
  }));

  return {
    db: {
      select: selectMock,
      insert: insertMock,
    },
    mocks: {
      insertMock,
      insertCalls,
      limitMock,
    },
  };
};

const buildRun = (overrides: Partial<RunLike> = {}): RunLike => ({
  id: 'run-1',
  userId: 'user-1',
  organizationId: 'org-1',
  scopeId: 'scope-1',
  goal: 'Assess API auth',
  sessionId: 'session-planner-or-executor',
  executorSessionId: 'session-executor',
  ...overrides,
});

describe('RunService run.digest fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('collects root, planner, executor, and phase sessions for run note lookups', async () => {
    const { db } = buildDb([]);
    const runService = new RunService(db as never, {} as never, {} as never);
    (runService as any).runPhaseRepository = {
      listSessionIdsByRunId: vi.fn().mockResolvedValue(['session-phase', 'session-planner']),
    };

    const sessionIds = await (runService as any).collectRunNoteSessionIds({
      ...buildRun({
        sessionId: 'session-root',
        plannerSessionId: 'session-planner',
        executorSessionId: 'session-executor',
      }),
      id: 'run-1',
    });

    expect(sessionIds).toEqual([
      'session-root',
      'session-planner',
      'session-executor',
      'session-phase',
    ]);
    expect((runService as any).runPhaseRepository.listSessionIdsByRunId).toHaveBeenCalledWith('run-1');
  });

  it('auto-inserts minimal run.digest when none exists for run sessions', async () => {
    const { db, mocks } = buildDb([]);
    const runService = new RunService(db as never, {} as never, {} as never);

    await (runService as any).ensureRunDigestOnCompletion(buildRun() as never);

    expect(mocks.insertMock).toHaveBeenCalledTimes(2);
    expect(mocks.insertCalls[0]).toMatchObject({
      values: expect.objectContaining({
        ntype: 'run.digest',
        userId: 'user-1',
        organizationId: 'org-1',
        scopeId: 'scope-1',
        sessionId: 'session-executor',
        title: 'Auto-generated run digest',
        data: {
          goal: 'Assess API auth',
          outcome: 'completed',
        },
      }),
    });
    expect(mocks.insertCalls[1]).toMatchObject({
      values: expect.objectContaining({
        runId: 'run-1',
        type: 'system',
        note: 'run_digest_fallback_generated',
      }),
    });
    expect(loggerMocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        sessionId: 'session-executor',
        note: 'run_digest_fallback_generated',
      }),
      '[runs] Degraded run.digest quality detected',
    );
  });

  it('routes Code Review completion through repository-bound memory instead of generic scope memory', async () => {
    const { db, mocks } = buildDb([{
      id: 'report-1',
      executiveSummary: 'The review validated one authorization defect.',
      completeness: 'partial',
      limitations: ['Generated sources were excluded.'],
    } as never]);
    const runService = new RunService(db as never, {} as never, {} as never);
    const upsertRunDigest = vi.fn().mockResolvedValue({ noteId: 'note-1', created: true });
    (runService as any).codeReviewMemoryService = { upsertRunDigest };
    const codeReviewContext = {
      operation: 'repository_review',
      repository: {
        provider: 'github',
        installationId: 'installation-1',
        repositoryId: 'repository-1',
        fullName: 'nullsquare/backend',
        visibility: 'private',
        immutableCommitSha: 'a'.repeat(40),
        requestedRef: 'main',
        defaultBranch: 'main',
      },
      reviewScope: {
        mode: 'repository',
        allowedPaths: [],
        excludedPaths: [],
        contextReadPolicy: 'immutable_manifest_only',
        manifestHash: 'b'.repeat(64),
        completeness: 'complete',
      },
      policySnapshot: {
        version: 'code-review/v1',
        toolProfile: 'code-review-read-only-v1',
        pathPolicy: 'immutable-manifest-bound',
        networkPolicy: 'github-read-only',
        publicationPolicy: 'none',
      },
    };

    await (runService as any).ensureRunDigestOnCompletion({
      ...buildRun(),
      workflowDiscipline: 'code_review',
      codeReviewContext,
    });

    expect(upsertRunDigest).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      sessionId: 'session-executor',
      context: codeReviewContext,
      outcome: 'The review validated one authorization defect.',
    }));
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('does not insert fallback when a run.digest already exists', async () => {
    const { db, mocks } = buildDb([
      {
        id: 'existing-note',
        title: 'Operator digest',
        data: {
          goal: 'Assess API auth',
          outcome: 'blocked',
          completed_tasks: ['Mapped public authentication routes'],
        },
        sessionId: 'session-executor',
      },
    ]);
    const runService = new RunService(db as never, {} as never, {} as never);

    await (runService as any).ensureRunDigestOnCompletion(buildRun() as never);

    expect(mocks.limitMock).toHaveBeenCalledTimes(1);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('signals degraded quality when an existing run.digest is thin', async () => {
    const { db, mocks } = buildDb([
      {
        id: 'existing-note',
        title: 'Manual digest',
        data: {
          goal: 'Assess API auth',
          outcome: 'blocked',
        },
        sessionId: 'session-executor',
      },
    ]);
    const runService = new RunService(db as never, {} as never, {} as never);

    await (runService as any).ensureRunDigestOnCompletion(buildRun() as never);

    expect(mocks.insertMock).toHaveBeenCalledTimes(1);
    expect(mocks.insertCalls[0]).toMatchObject({
      values: expect.objectContaining({
        runId: 'run-1',
        type: 'system',
        note: 'run_digest_low_quality',
      }),
    });
  });

  it('does not signal degraded quality for a rich run.digest', async () => {
    const { db, mocks } = buildDb([
      {
        id: 'existing-note',
        title: 'Operator digest',
        data: {
          goal: 'Assess API auth',
          outcome: 'blocked',
          completed_tasks: ['Mapped public authentication routes'],
        },
        sessionId: 'session-executor',
      },
    ]);
    const runService = new RunService(db as never, {} as never, {} as never);

    await (runService as any).ensureRunDigestOnCompletion(buildRun() as never);

    expect(mocks.insertMock).not.toHaveBeenCalled();
    expect(loggerMocks.loggerWarn).not.toHaveBeenCalled();
  });
});
