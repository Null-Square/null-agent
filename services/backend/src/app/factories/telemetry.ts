import type { ResolvedConfig } from '@/config/configTypes';
import { SessionTraceRecorder, TraceRetentionService } from '@/domains/agent-brain/infrastructure/telemetry';
import { TraceIndexRepository } from '@/domains/agent-brain/adapters/persistence/TraceIndexRepository';
import type { S3Bundle } from './storage';
import type { DIContainer } from '../container';
import { TOKENS } from '../tokens';

export const createTraceRetention = (
  config: ResolvedConfig,
  s3Bundle: S3Bundle,
  repo: TraceIndexRepository,
): TraceRetentionService | undefined => {
  if (!s3Bundle.s3TracesClient || config.trace.traceRetentionDays <= 0) {
    return undefined;
  }
  return new TraceRetentionService(repo, s3Bundle.s3TracesClient, config.trace.traceRetentionDays);
};

export const createTraceRecorder = (
  config: ResolvedConfig,
  s3Bundle: S3Bundle,
  repo: TraceIndexRepository,
): SessionTraceRecorder => {
  return new SessionTraceRecorder(
    {
      rootDir: config.trace.traceLogsRoot,
      inlineLimit: config.trace.traceInlineLimit,
      stdoutChunkSize: config.trace.stdoutChunkSize,
      compressOverBytes: config.trace.traceCompressOverBytes,
      retentionDays: config.trace.traceRetentionDays,
      s3FlushIntervalMs: config.trace.s3FlushIntervalMs,
      s3FlushMaxEvents: config.trace.s3FlushMaxEvents,
      // REMOVED Dec 2025: keepLocalCopy - hard-coded to false
    },
    s3Bundle.s3TracesClient ? { client: s3Bundle.s3TracesClient, bucket: s3Bundle.s3TracesBucket } : undefined,
    repo,
  );
};

// ======================================================================================
// DI Registration Helpers (composition -> factories)
// ======================================================================================

export const registerTelemetry = (
  container: DIContainer,
  config: ResolvedConfig,
): void => {
  container.register<TraceIndexRepository>(TOKENS.traceIndexRepository, () => new TraceIndexRepository());

  container.register<ReturnType<typeof createTraceRetention> | undefined>(
    TOKENS.traceRetentionService,
    async (c) => {
      const traceIndexRepository = await c.resolve<TraceIndexRepository>(TOKENS.traceIndexRepository);
      const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
      return createTraceRetention(config, s3Bundle, traceIndexRepository);
    },
  );

  container.register(TOKENS.traceRecorder, async (c) => {
    const traceIndexRepository = await c.resolve<TraceIndexRepository>(TOKENS.traceIndexRepository);
    const s3Bundle = await c.resolve<S3Bundle>(TOKENS.s3Bundle);
    return createTraceRecorder(config, s3Bundle, traceIndexRepository);
  });
};
