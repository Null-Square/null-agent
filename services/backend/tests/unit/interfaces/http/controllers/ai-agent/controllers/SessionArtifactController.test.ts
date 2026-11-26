import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@null-ai/contracts';
import { SessionArtifactController } from '@/interfaces/http/controllers/ai-agent/controllers/SessionArtifactController';

const makeController = (overrides: {
  artifactRepository?: { listBySession: ReturnType<typeof vi.fn> };
  sessionRepository?: { findById: ReturnType<typeof vi.fn> };
  responseBuilder?: Record<string, ReturnType<typeof vi.fn>>;
} = {}) => {
  const artifactRepository = overrides.artifactRepository ?? {
    listBySession: vi.fn().mockResolvedValue([]),
  };
  const sessionRepository = overrides.sessionRepository ?? {
    findById: vi.fn().mockResolvedValue({ id: 'session-1', userId: 'user-1' }),
  };
  const responseBuilder = overrides.responseBuilder ?? {
    adaptArtifactRow: vi.fn((row) => row),
    buildDownloadUrl: vi.fn(),
    readArtifactContent: vi.fn(),
  };

  return {
    artifactRepository,
    sessionRepository,
    responseBuilder,
    controller: new SessionArtifactController({
      services: {
        sessionStore: { get: vi.fn(() => undefined) },
      },
      sessionRepository,
      messageRepository: {} as never,
      artifactRepository,
      sessionService: {} as never,
      sessionSummaryService: {} as never,
      accessControl: {} as never,
      responseBuilder,
      artifactStorageRoot: 'C:/tmp',
      log: { warn: vi.fn() } as never,
      options: {},
    } as never),
  };
};

describe('SessionArtifactController', () => {
  it('returns an empty app artifact inventory without reading raw artifacts', async () => {
    const { controller, artifactRepository, responseBuilder } = makeController({
      artifactRepository: {
        listBySession: vi.fn().mockResolvedValue([
          {
            id: 'artifact-raw',
            filePath: 'sessions/session-1/.artifacts/scans/httpx.jsonl',
            originalName: '.artifacts/scans/httpx.jsonl',
          },
        ]),
      },
    });
    const req = {
      params: { sessionId: 'session-1' },
      user: { id: 'user-1' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await controller.listArtifacts(req as never, res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ artifacts: [] });
    expect(artifactRepository.listBySession).not.toHaveBeenCalled();
    expect(responseBuilder.buildDownloadUrl).not.toHaveBeenCalled();
  });

  it('rejects raw artifact content through the app API', async () => {
    const { controller, artifactRepository, responseBuilder } = makeController({
      artifactRepository: {
        listBySession: vi.fn().mockResolvedValue([
          {
            id: 'artifact-raw',
            filePath: 'sessions/session-1/.artifacts/report/context.json',
            originalName: '.artifacts/report/context.json',
          },
        ]),
      },
    });
    const req = {
      params: { sessionId: 'session-1', artifactId: 'artifact-raw' },
      user: { id: 'user-1' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    await expect(controller.getArtifactContent(req as never, res as never)).rejects.toMatchObject({
      code: ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS,
      httpStatus: 403,
      context: expect.objectContaining({
        sessionId: 'session-1',
        resource: 'artifact raw content',
      }),
    });
    expect(artifactRepository.listBySession).not.toHaveBeenCalled();
    expect(responseBuilder.readArtifactContent).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});