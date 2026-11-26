import type { AppConfigEnv } from '@/config/configSchema';
import type { ResolvedConfig } from '@/config/configTypes';
import { SessionPersistenceService } from '@/domains/agent-brain/infrastructure/persistence/SessionPersistenceService';
import { S3WorkspaceManager } from '@/domains/agent-brain/adapters/workspace';
import type { WorkspaceManager } from '@/domains/agent-brain/ports';
import {
  SessionRepository,
  MessageRepository,
  ArtifactRepository,
  CheckpointRepository,
  SessionEventJournalRepository,
} from '@/domains/agent-brain/adapters/persistence';
import { UsageRecordRepository } from '@/domains/platform/subscriptions/infrastructure/UsageRecordRepository';
import { DbUsageStore } from '@/domains/platform/subscriptions/infrastructure/usageStores';
import { S3StorageService } from '@/shared/storage/S3StorageService';
import { logger } from '@/shared/logger';
import type { DIContainer } from '../container';
import type { LifecycleManager } from '../lifecycle';
import { TOKENS } from '../tokens';
import {
  supportsDurableProviderAttemptLifecycle,
  type SessionRepositoryPort,
  type SessionEventJournalPort,
  type UsageStorePort,
} from '@/domains/agent-brain/ports';
import { isVerboseSessionLoggingEnabled } from '@/shared/logging/sessionLogging';
import {
  RuntimeHostCapabilityRegistrationError,
  type RuntimeHostCapabilities,
} from '@/domains/agent-brain/domain/runtime/RuntimeHostCapabilities';


export type SessionPersistenceBundle = {
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  artifactRepository: ArtifactRepository;
  checkpointRepository: CheckpointRepository;
  sessionEventJournal: SessionEventJournalRepository;
  sessionPersistence: SessionPersistenceService;
};

export type S3Bundle = {
  s3Client?: S3StorageService;
  s3TracesClient?: S3StorageService;
  s3WorkspacesClient?: S3StorageService;
  s3ArtifactsBucket: string;
  s3TracesBucket: string;
  s3WorkspacesBucket: string;
};


/**
 * Create workspace manager - S3/MinIO storage is REQUIRED.
 * Local filesystem is only used as temp cache during active sessions.
 * Throws if S3 is not configured.
 */
export const createWorkspaceManager = (
  config: ResolvedConfig['workspace'],
  s3Bundle: S3Bundle,
): WorkspaceManager => {
  if (!s3Bundle.s3WorkspacesClient) {
    throw new Error('[StorageFactory] S3 workspace storage is required. Configure S3_ENDPOINT and S3_BUCKET_WORKSPACES.');
  }

  const maxWorkspaceBytes = config.maxBytesPerWorkspace ?? 0;
  const maxBytes = Number.isFinite(maxWorkspaceBytes) && maxWorkspaceBytes > 0 ? maxWorkspaceBytes : undefined;

  logger.info('[StorageFactory] Using S3WorkspaceManager for workspace storage');
  return new S3WorkspaceManager(s3Bundle.s3WorkspacesClient, {
    localRoot: config.rootDir,
    maxBytesPerWorkspace: maxBytes,
  });
};

/**
 * Create session persistence bundle - DB-only (Dec 2025 simplification).
 * Redis cache layer removed per Codex/Anthropic patterns.
 */
export const createSessionPersistence = (
  _sessionTTL: number,
  _workspaceManager: WorkspaceManager,
  options: { verboseLogging?: boolean } = {},
): SessionPersistenceBundle => {
  const sessionRepository = new SessionRepository();
  const messageRepository = new MessageRepository();
  const artifactRepository = new ArtifactRepository();
  const checkpointRepository = new CheckpointRepository();
  const sessionEventJournal = new SessionEventJournalRepository();
  
  // Simplified to DB-only (Dec 2025: removed Hybrid wrapper, now using SessionPersistenceService directly)
  const sessionPersistence = new SessionPersistenceService({
    sessions: sessionRepository,
    messages: messageRepository,
    artifacts: artifactRepository,
    checkpoints: checkpointRepository,
  }, options);
  
  return {
    sessionRepository,
    messageRepository,
    artifactRepository,
    checkpointRepository,
    sessionEventJournal,
    sessionPersistence,
  };
};

export const createS3Bundle = (envConfig: AppConfigEnv): S3Bundle => {
  const s3Enabled =
    Boolean(envConfig.S3_ENDPOINT) &&
    Boolean(envConfig.S3_ACCESS_KEY) &&
    Boolean(envConfig.S3_SECRET_KEY);

  const s3ArtifactsBucket = envConfig.S3_BUCKET_ARTIFACTS || 'nullai-artifacts';
  const s3TracesBucket = envConfig.S3_BUCKET_TRACES || 'nullai-traces';
  const s3WorkspacesBucket = envConfig.S3_BUCKET_WORKSPACES || 'nullai-workspaces';
  const forcePathStyle = envConfig.S3_FORCE_PATH_STYLE ?? true;
  const autoCreateBucket = envConfig.S3_AUTO_CREATE_BUCKETS ?? true;
  const region = envConfig.S3_REGION || 'us-east-1';

  const s3Client = s3Enabled
    ? new S3StorageService({
      endpoint: envConfig.S3_ENDPOINT!,
      publicEndpoint: envConfig.S3_PUBLIC_ENDPOINT, // Browser-accessible endpoint
      region,
      accessKeyId: envConfig.S3_ACCESS_KEY!,
      secretAccessKey: envConfig.S3_SECRET_KEY!,
      forcePathStyle,
      autoCreateBucket,
      bucket: s3ArtifactsBucket,
      metricsLabel: 'artifacts',
    })
    : undefined;

  const s3TracesClient = s3Enabled
    ? new S3StorageService({
      endpoint: envConfig.S3_ENDPOINT!,
      publicEndpoint: envConfig.S3_PUBLIC_ENDPOINT, // Browser-accessible endpoint  
      region,
      accessKeyId: envConfig.S3_ACCESS_KEY!,
      secretAccessKey: envConfig.S3_SECRET_KEY!,
      forcePathStyle,
      autoCreateBucket,
      bucket: s3TracesBucket,
      metricsLabel: 'traces',
    })
    : undefined;

  const s3WorkspacesClient = s3Enabled
    ? new S3StorageService({
      endpoint: envConfig.S3_ENDPOINT!,
      region,
      accessKeyId: envConfig.S3_ACCESS_KEY!,
      secretAccessKey: envConfig.S3_SECRET_KEY!,
      forcePathStyle,
      autoCreateBucket,
      bucket: s3WorkspacesBucket,
    })
    : undefined;

  return { s3Client, s3TracesClient, s3WorkspacesClient, s3ArtifactsBucket, s3TracesBucket, s3WorkspacesBucket };
};

export const createUsageStore = (): DbUsageStore => {
  const repo = new UsageRecordRepository();
  return new DbUsageStore(repo);
};

// ======================================================================================
// DI Registration Helpers (composition -> factories)
// ======================================================================================

export const registerStorage = (
  container: DIContainer,
  _lifecycle: LifecycleManager,
  config: ResolvedConfig,
  envConfig: AppConfigEnv,
  sessionTTL: number,
  options: {
    runtimeHostCapabilities: RuntimeHostCapabilities;
    providerAttemptStore?: UsageStorePort;
  },
): void => {
  // S3Bundle must be created first since workspace manager requires it
  container.register<S3Bundle>(TOKENS.s3Bundle, async () => {
    return createS3Bundle(envConfig);
  });

  container.register<WorkspaceManager>(TOKENS.workspaceManager, async (c) => {
    const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
    return createWorkspaceManager(config.workspace, s3Bundle);
  });

  container.register<SessionPersistenceBundle>(TOKENS.sessionPersistenceBundle, async (c) => {
    const workspaceManager = await c.resolve<WorkspaceManager>(TOKENS.workspaceManager);
    const bundle = createSessionPersistence(sessionTTL, workspaceManager, {
      verboseLogging: isVerboseSessionLoggingEnabled(),
    });
    return bundle;
  });

  container.register<SessionRepositoryPort>(TOKENS.sessionRepository, async (c) => {
    const { sessionPersistence } = await c.resolve<SessionPersistenceBundle>(TOKENS.sessionPersistenceBundle);
    return sessionPersistence as unknown as SessionRepositoryPort;
  });

  // Session persistence is DB-only; no separate distributed lock layer remains.

  container.register<UsageStorePort>(TOKENS.usageStore, () => {
    if (options.runtimeHostCapabilities.hostKind !== 'research_lab') return createUsageStore();
    if (
      options.runtimeHostCapabilities.providerAttempts.schemaVersion >= 2
      && !supportsDurableProviderAttemptLifecycle(options.providerAttemptStore)
    ) {
      throw new RuntimeHostCapabilityRegistrationError([
        'host=research_lab lifecycle=providerAttempts adapter=missing_v2_contract',
      ]);
    }
    if (!options.providerAttemptStore) {
      throw new RuntimeHostCapabilityRegistrationError([
        'host=research_lab lifecycle=providerAttempts adapter=missing',
      ]);
    }
    return options.providerAttemptStore;
  });

  container.register<SessionEventJournalPort>(TOKENS.sessionEventJournal, async (c) => {
    const { sessionEventJournal } = await c.resolve<SessionPersistenceBundle>(TOKENS.sessionPersistenceBundle);
    return sessionEventJournal;
  });
};

