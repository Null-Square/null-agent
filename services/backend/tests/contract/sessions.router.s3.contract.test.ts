import { vi, describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import path from 'path';
import request from 'supertest';
import { sessionsRouter } from '@/interfaces/http/controllers/ai-agent/routes/sessions.router';
import { errorHandler } from '@/interfaces/http/controllers/ai-agent/middleware/errors';
import type { AgentApiServices } from '@/interfaces/http/controllers/ai-agent/types';
import { ERROR_CODES } from '@null-ai/contracts';

const s3Mocks = vi.hoisted(() => ({
  getObjectBuffer: vi.fn(),
  getPresignedUrl: vi.fn(),
  ensureBucket: vi.fn(),
  getBucket: vi.fn(() => 'test-bucket'),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  promises: {
    readFile: vi.fn(),
  },
}));

vi.mock('fs', () => ({
  existsSync: fsMocks.existsSync,
  promises: {
    readFile: fsMocks.promises.readFile,
  },
}));

vi.mock('@/shared/storage/S3StorageService', () => ({
  S3StorageService: class {
    constructor(_config: any) {}
    getObjectBuffer = s3Mocks.getObjectBuffer;
    getPresignedUrl = s3Mocks.getPresignedUrl;
    ensureBucket = s3Mocks.ensureBucket;
    getBucket = s3Mocks.getBucket;
  },
}));

vi.mock('@/config/bootstrapConfig', () => ({
  __esModule: true,
  default: {
    s3: {
      endpoint: 'http://s3.local',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      artifactsBucket: 'test-bucket',
      forcePathStyle: true,
    },
  },
  config: {
    s3: {
      endpoint: 'http://s3.local',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      artifactsBucket: 'test-bucket',
      forcePathStyle: true,
    },
  },
}));

vi.mock('@/domains/agent-brain/adapters/persistence', () => ({
  SessionRepository: class {},
  MessageRepository: class {},
  ArtifactRepository: class {},
  CheckpointRepository: class {},
}));

const buildServices = (session: any): AgentApiServices => {
  const sessionStore = {
    get: vi.fn(() => session),
    listByUser: vi.fn(() => []),
    remove: vi.fn(() => true),
    set: vi.fn(),
    setAsync: vi.fn(),
    abortCurrentTurnAsync: vi.fn(),
  };

  return {
    streamBroker: {} as any,
    sessionStore,
    checkpointManager: {
      list: vi.fn(),
      create: vi.fn(),
      restore: vi.fn(),
    },
    sandbox: { writeFile: vi.fn().mockResolvedValue(undefined) } as any,
    toolsRegistry: {} as any,
    orchestrator: {} as any,
    traceRecorder: undefined,
    usageTracker: undefined,
    sandboxProfileRegistry: {} as any,
    usageStore: undefined,
    ports: {
      events: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
      tools: { handleApprovalDecision: vi.fn() },
      tasks: { getTask: vi.fn() },
    },
    agentEngine: {
      cleanupSession: vi.fn(),
      stopSandbox: vi.fn(),
      getSandboxPolicy: vi.fn().mockResolvedValue(null),
    } as any,
    artifactService: {
      getStorageRoot: vi.fn(() => path.resolve(process.cwd(), 'artifacts')),
    } as any,
    s3ArtifactsClient: {
      getObjectBuffer: s3Mocks.getObjectBuffer,
      getPresignedUrl: s3Mocks.getPresignedUrl,
      ensureBucket: s3Mocks.ensureBucket,
      getBucket: s3Mocks.getBucket,
    } as any,
    policyResolver: {
      getDefaultPolicy: vi.fn(),
      getBySlug: vi.fn(),
      resolvePolicy: vi.fn(),
    } as any,
    policyFacade: undefined,
    accessControl: {
      enforceSessionCreation: vi.fn().mockResolvedValue(undefined),
      enforceMessage: vi.fn().mockResolvedValue(undefined),
      resolveSubscription: vi.fn().mockResolvedValue({
        plan: { features: {}, limits: {} },
        creditsCurrent: 0,
      }),
    } as any,
    sessionRepository: { findById: vi.fn() } as any,
    messageRepository: { listBySessionPaged: vi.fn() } as any,
    artifactRepository: { listBySession: vi.fn().mockResolvedValue([]) } as any,
  } as unknown as AgentApiServices;
};

const buildApp = (services: AgentApiServices) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 'user-1' };
    next();
  });
  app.use(sessionsRouter(services as any));
  app.use(errorHandler);
  return app;
};

describe('sessions.router s3 artifacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    s3Mocks.getPresignedUrl.mockResolvedValue('https://s3.local/presign');
    s3Mocks.getObjectBuffer.mockResolvedValue(Buffer.from('s3-content'));
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.promises.readFile.mockResolvedValue('local-content');
  });

  it('returns an empty app artifact inventory for s3 artifacts', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a1',
          filePath: 's3://test-bucket/sessions/s1/report.md',
          originalName: 'report.md',
          fileType: 'text/markdown',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 's3',
          bucket: 'test-bucket',
        },
      ],
    };
    const services = buildServices(session);
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts');

    expect(res.status).toBe(200);
    expect(res.body.artifacts).toEqual([]);
    expect(s3Mocks.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('streams s3 artifact downloads through backend proxy', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a1',
          filePath: 's3://test-bucket/sessions/s1/report.md',
          originalName: 'report.md',
          fileType: 'text/markdown',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 's3',
          bucket: 'test-bucket',
        },
      ],
    };
    const services = buildServices(session);
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts/a1/download');

    expect(res.status).toBe(200);
    expect(s3Mocks.getObjectBuffer).toHaveBeenCalledWith('sessions/s1/report.md');
    expect(res.text).toBe('s3-content');
    expect(res.headers['content-disposition']).toContain('report.md');
  });

  it('blocks raw s3 artifact content for app sessions', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a1',
          filePath: 's3://test-bucket/sessions/s1/report.md',
          originalName: 'report.md',
          fileType: 'text/markdown',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 's3',
          bucket: 'test-bucket',
        },
      ],
    };
    const services = buildServices(session);
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts/a1/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
    expect(s3Mocks.getObjectBuffer).not.toHaveBeenCalled();
  });

  it('blocks raw s3 artifact content before attempting fallback reads', async () => {
    const session = {
      id: 's1',
      userId: 'user-1',
      createdAt: Date.now(),
      lastActive: Date.now(),
      mode: 'interactive',
      messages: [],
      plan: [],
      flags: {},
      artifacts: [
        {
          id: 'a1',
          filePath: 's3://test-bucket/sessions/s1/report.md',
          originalName: 'report.md',
          fileType: 'text/markdown',
          sizeBytes: 12,
          createdAt: Date.now(),
          storage: 's3',
          bucket: 'test-bucket',
        },
      ],
    };
    s3Mocks.getObjectBuffer.mockRejectedValueOnce(new Error('s3 down'));
    fsMocks.existsSync.mockReturnValueOnce(false);
    const services = buildServices(session);
    const app = buildApp(services);

    const res = await request(app).get('/sessions/s1/artifacts/a1/content');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ERROR_CODES.AUTH_INSUFFICIENT_PERMISSIONS);
  });
});
