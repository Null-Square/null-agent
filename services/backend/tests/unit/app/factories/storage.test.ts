import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedConfig } from '@/config/configTypes';
import type {
  createWorkspaceManager as CreateWorkspaceManager,
  createS3Bundle as CreateS3Bundle,
  createUsageStore as CreateUsageStore,
  createSessionPersistence as CreateSessionPersistence,
} from '@/app/factories/storage';

const mocks = vi.hoisted(() => ({
  s3Ctor: vi.fn(),
  workspaceManagerCtor: vi.fn(),
  usageRepoCtor: vi.fn(),
  dbUsageCtor: vi.fn(),
  inMemoryCtor: vi.fn(),
  loggerInfo: vi.fn(),
  sessionRepoCtor: vi.fn(),
  messageRepoCtor: vi.fn(),
  artifactRepoCtor: vi.fn(),
  checkpointRepoCtor: vi.fn(),
  sessionEventJournalCtor: vi.fn(),
  sessionPersistenceCtor: vi.fn(),
}));

let createWorkspaceManager: typeof CreateWorkspaceManager;
let createS3Bundle: typeof CreateS3Bundle;
let createUsageStore: typeof CreateUsageStore;
let createSessionPersistence: typeof CreateSessionPersistence;

describe('storage factories', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@/shared/logger', () => ({
      logger: { info: mocks.loggerInfo, child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
    }));
    vi.doMock('@/shared/storage/S3StorageService', () => ({
      S3StorageService: vi.fn().mockImplementation((options) => {
        mocks.s3Ctor(options);
        return { options };
      }),
    }));
    vi.doMock('@/domains/agent-brain/adapters/workspace', () => ({
      S3WorkspaceManager: vi.fn().mockImplementation((client, options) => {
        mocks.workspaceManagerCtor(client, options);
        return { client, options };
      }),
    }));
    vi.doMock('@/domains/platform/subscriptions/infrastructure/UsageRecordRepository', () => ({
      UsageRecordRepository: vi.fn().mockImplementation(() => {
        mocks.usageRepoCtor();
        return { create: vi.fn(), summarizeSession: vi.fn() };
      }),
    }));
    vi.doMock('@/domains/platform/subscriptions/infrastructure/usageStores', () => ({
      DbUsageStore: vi.fn().mockImplementation((repo, fallback) => {
        mocks.dbUsageCtor(repo, fallback);
        return { repo, fallback };
      }),
      InMemoryUsageStore: vi.fn().mockImplementation(() => {
        mocks.inMemoryCtor();
        return { kind: 'memory' };
      }),
    }));
    vi.doMock('@/domains/agent-brain/adapters/persistence', () => ({
      SessionRepository: vi.fn().mockImplementation(() => {
        mocks.sessionRepoCtor();
        return { id: 'session-repo' };
      }),
      MessageRepository: vi.fn().mockImplementation(() => {
        mocks.messageRepoCtor();
        return { id: 'message-repo' };
      }),
      ArtifactRepository: vi.fn().mockImplementation(() => {
        mocks.artifactRepoCtor();
        return { id: 'artifact-repo' };
      }),
      CheckpointRepository: vi.fn().mockImplementation(() => {
        mocks.checkpointRepoCtor();
        return { id: 'checkpoint-repo' };
      }),
      SessionEventJournalRepository: vi.fn().mockImplementation(() => {
        mocks.sessionEventJournalCtor();
        return { id: 'session-event-journal' };
      }),
    }));
    vi.doMock('@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService', () => ({
      SessionPersistenceService: vi.fn().mockImplementation((deps) => {
        mocks.sessionPersistenceCtor(deps);
        return { deps };
      }),
    }));
    const mod = await import('@/app/factories/storage');
    createWorkspaceManager = mod.createWorkspaceManager;
    createS3Bundle = mod.createS3Bundle;
    createUsageStore = mod.createUsageStore;
    createSessionPersistence = mod.createSessionPersistence;
    vi.clearAllMocks();
  });

  it('throws when S3 workspaces client is missing', () => {
    const config = {
      rootDir: '/tmp/workspaces',
      maxBytesPerWorkspace: 1024,
    } as ResolvedConfig['workspace'];

    expect(() => createWorkspaceManager(config, { s3WorkspacesClient: undefined } as any)).toThrow(
      'S3 workspace storage is required',
    );
  });

  it('creates S3 workspace manager with normalized max bytes', () => {
    const config = {
      rootDir: '/tmp/workspaces',
      maxBytesPerWorkspace: 0,
    } as ResolvedConfig['workspace'];
    const s3WorkspacesClient = { name: 's3' };

    createWorkspaceManager(config, { s3WorkspacesClient } as any);

    expect(mocks.workspaceManagerCtor).toHaveBeenCalledWith(s3WorkspacesClient, {
      localRoot: '/tmp/workspaces',
      maxBytesPerWorkspace: undefined,
    });
  });

  it('returns empty S3 bundle when credentials are missing', () => {
    const bundle = createS3Bundle({} as any);

    expect(bundle.s3Client).toBeUndefined();
    expect(bundle.s3TracesClient).toBeUndefined();
    expect(bundle.s3WorkspacesClient).toBeUndefined();
    expect(mocks.s3Ctor).not.toHaveBeenCalled();
  });

  it('builds S3 clients when credentials are present', () => {
    const bundle = createS3Bundle({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY: 'key',
      S3_SECRET_KEY: 'secret',
      S3_FORCE_PATH_STYLE: false,
      S3_AUTO_CREATE_BUCKETS: false,
      S3_BUCKET_ARTIFACTS: 'artifacts',
      S3_BUCKET_TRACES: 'traces',
      S3_BUCKET_WORKSPACES: 'workspaces',
    } as any);

    expect(mocks.s3Ctor).toHaveBeenCalledTimes(3);
    const [artifactOpts, traceOpts, workspaceOpts] = mocks.s3Ctor.mock.calls.map((call) => call[0]);
    expect(artifactOpts.bucket).toBe('artifacts');
    expect(artifactOpts.autoCreateBucket).toBe(false);
    expect(traceOpts.bucket).toBe('traces');
    expect(traceOpts.metricsLabel).toBe('traces');
    expect(workspaceOpts.bucket).toBe('workspaces');
    expect(bundle.s3TracesClient).toBeDefined();
  });

  it('creates a DB-only billable usage store', () => {
    const store = createUsageStore();

    expect(mocks.usageRepoCtor).toHaveBeenCalledTimes(1);
    expect(mocks.inMemoryCtor).not.toHaveBeenCalled();
    expect(mocks.dbUsageCtor).toHaveBeenCalledTimes(1);
    expect((store as any).fallback).toBeUndefined();
  });

  it('builds a DB-only session persistence bundle', () => {
    const bundle = createSessionPersistence(3600, {} as any);

    expect(mocks.sessionRepoCtor).toHaveBeenCalledTimes(1);
    expect(mocks.messageRepoCtor).toHaveBeenCalledTimes(1);
    expect(mocks.artifactRepoCtor).toHaveBeenCalledTimes(1);
    expect(mocks.checkpointRepoCtor).toHaveBeenCalledTimes(1);
    expect(mocks.sessionEventJournalCtor).toHaveBeenCalledTimes(1);
    expect(bundle.sessionEventJournal).toEqual({ id: 'session-event-journal' });
    expect(mocks.sessionPersistenceCtor).toHaveBeenCalledWith({
      sessions: { id: 'session-repo' },
      messages: { id: 'message-repo' },
      artifacts: { id: 'artifact-repo' },
      checkpoints: { id: 'checkpoint-repo' },
    });
    expect((bundle.sessionPersistence as any).deps).toEqual({
      sessions: { id: 'session-repo' },
      messages: { id: 'message-repo' },
      artifacts: { id: 'artifact-repo' },
      checkpoints: { id: 'checkpoint-repo' },
    });
  });
});
