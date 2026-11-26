import { describe, expect, it, vi } from 'vitest';
import { SessionCrudController } from '@/interfaces/http/controllers/ai-agent/controllers/SessionCrudController';

const toDate = (value: string) => new Date(value);

describe('SessionCrudController.listSessions', () => {
  it('excludes read-only assistant sessions from the normal session list', async () => {
    const sessionRepository = {
      listByUser: vi.fn().mockResolvedValue([
        {
          id: 'session-assistant-db',
          userId: 'user-1',
          title: 'Assistant session',
          metadata: {
            flags: {
              securityops: {
                assistantMode: 'read_only_chat',
              },
            },
          },
          blockedReason: null,
          completed: false,
          mode: 'interactive',
          createdAt: toDate('2026-04-03T08:00:00.000Z'),
          updatedAt: toDate('2026-04-03T08:05:00.000Z'),
          lastActiveAt: toDate('2026-04-03T08:05:00.000Z'),
          summary: null,
        },
        {
          id: 'session-visible',
          userId: 'user-1',
          title: 'Visible session',
          metadata: {},
          blockedReason: null,
          completed: false,
          mode: 'interactive',
          createdAt: toDate('2026-04-03T09:00:00.000Z'),
          updatedAt: toDate('2026-04-03T09:05:00.000Z'),
          lastActiveAt: toDate('2026-04-03T09:05:00.000Z'),
          summary: null,
        },
      ]),
    };

    const sessionStore = {
      listByUser: vi.fn().mockReturnValue([
        {
          id: 'session-assistant-live',
          userId: 'user-1',
          createdAt: Date.parse('2026-04-03T10:00:00.000Z'),
          lastActive: Date.parse('2026-04-03T10:10:00.000Z'),
          flags: {
            securityops: {
              assistantMode: 'read_only_chat',
            },
          },
        },
      ]),
      getExecutionReadModels: vi.fn().mockResolvedValue(new Map()),
    };

    const responseBuilder = {
      toMillis: vi.fn((value: Date | number | undefined, fallback: number) => {
        if (value instanceof Date) {
          return value.getTime();
        }
        if (typeof value === 'number') {
          return value;
        }
        return fallback;
      }),
      deriveSessionState: vi.fn(() => ({
        status: 'idle',
        pauseReason: null,
        interactionType: 'none',
      })),
      deriveRuntimeState: vi.fn(() => ({
        status: 'idle',
        pauseReason: null,
        interactionType: 'none',
        blockedReason: null,
        isProcessing: false,
        completed: false,
        pendingApproval: null,
      })),
    };

    const controller = new SessionCrudController({
      services: {
        sessionStore,
      },
      sessionRepository,
      messageRepository: {} as never,
      artifactRepository: {} as never,
      sessionService: {} as never,
      sessionSummaryService: {} as never,
      accessControl: {} as never,
      responseBuilder,
      artifactStorageRoot: 'C:/tmp',
      log: { child: () => ({}) } as never,
      options: {},
    } as never);

    const req = {
      user: { id: 'user-1' },
      query: {},
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await controller.listSessions(req as never, res as never);

    expect(sessionRepository.listByUser).toHaveBeenCalledWith('user-1', {
      limit: 51,
      offset: 0,
      status: undefined,
    });

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledTimes(1);

    const payload = res.json.mock.calls[0][0] as {
      sessions: Array<{ id: string }>;
      hasMore: boolean;
    };

    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]?.id).toBe('session-visible');
    expect(payload.hasMore).toBe(false);
  });
});

describe('SessionCrudController.getSession', () => {
  it('omits raw artifacts from app session details while preserving report content', async () => {
    const sessionRepository = {
      findById: vi.fn().mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        title: 'Completed run',
        metadata: {},
        blockedReason: null,
        completed: true,
        mode: 'automated',
        createdAt: toDate('2026-04-03T09:00:00.000Z'),
        updatedAt: toDate('2026-04-03T09:05:00.000Z'),
        lastActiveAt: toDate('2026-04-03T09:05:00.000Z'),
        summary: null,
        plan: [],
      }),
    };
    const artifactRepository = {
      listBySession: vi.fn().mockResolvedValue([
        {
          id: 'artifact-report',
          filePath: 'sessions/session-1/report.md',
          originalName: 'report.md',
          fileType: 'md',
          sizeBytes: 100,
          createdAt: Date.now(),
        },
        {
          id: 'artifact-summary',
          filePath: 'sessions/session-1/summary.md',
          originalName: 'summary.md',
          fileType: 'md',
          sizeBytes: 80,
          createdAt: Date.now(),
        },
        {
          id: 'artifact-raw',
          filePath: 'sessions/session-1/.artifacts/scans/httpx.jsonl',
          originalName: '.artifacts/scans/httpx.jsonl',
          fileType: 'jsonl',
          sizeBytes: 240,
          createdAt: Date.now(),
        },
      ]),
    };
    const responseBuilder = {
      adaptArtifactRow: vi.fn((row) => row),
      getCachedArtifactContent: vi.fn(() => undefined),
      setCachedArtifactContent: vi.fn(),
      readArtifactContent: vi.fn(async (_sessionId: string, artifact: { id: string }) => ({
        content: artifact.id === 'artifact-summary' ? '# Safe summary' : '# Safe report',
      })),
      deriveRuntimeState: vi.fn(() => ({
        status: 'completed',
        pauseReason: null,
        interactionType: 'none',
        blockedReason: null,
        isProcessing: false,
        completed: true,
        pendingApproval: null,
      })),
      filterVisibleMessages: vi.fn(() => []),
      toMessageResponse: vi.fn(),
    };

    const controller = new SessionCrudController({
      services: {
        sessionStore: {
          get: vi.fn(() => undefined),
          getExecutionReadModel: vi.fn().mockResolvedValue({}),
        },
      },
      sessionRepository,
      messageRepository: {
        listBySessionPaged: vi.fn().mockResolvedValue({ data: [] }),
      },
      artifactRepository,
      sessionService: {} as never,
      sessionSummaryService: {} as never,
      accessControl: {} as never,
      responseBuilder,
      artifactStorageRoot: 'C:/tmp',
      log: { child: () => ({ warn: vi.fn() }) } as never,
      options: {},
    } as never);

    const req = {
      params: { sessionId: 'session-1' },
      user: { id: 'user-1' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await controller.getSession(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0] as {
      session: { artifacts: unknown[]; report?: string; summary?: string };
    };

    expect(payload.session.report).toBe('# Safe report');
    expect(payload.session.summary).toBe('# Safe summary');
    expect(payload.session.artifacts).toEqual([]);
    expect(responseBuilder.readArtifactContent).toHaveBeenCalledTimes(2);
  });
});
