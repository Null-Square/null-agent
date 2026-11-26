import { checkDbHealth } from '@/db/client';
import type { S3StorageService } from '@/shared/storage/S3StorageService';

export type DbHealthStatus = {
  status: 'ok' | 'down';
  latencyMs: number;
  error?: string;
};

export type S3HealthStatus = {
  status: 'ok' | 'down' | 'disabled';
  bucket?: string;
  latencyMs?: number;
  error?: string;
};

export const buildDbStatus = async (): Promise<DbHealthStatus> => {
  const result = await checkDbHealth();
  return result.ok
    ? { status: 'ok', latencyMs: result.ms }
    : { status: 'down', latencyMs: result.ms, error: result.error };
};

export const buildS3Status = async (
  client?: S3StorageService,
  bucket?: string,
): Promise<S3HealthStatus> => {
  if (!client) {
    return { status: 'disabled', bucket };
  }
  const result = await client.checkHealth();
  return result.ok
    ? { status: 'ok', bucket, latencyMs: result.ms }
    : { status: 'down', bucket, latencyMs: result.ms, error: result.error };
};

export const checkDependencies = async (deps: {
  s3ArtifactsClient?: S3StorageService;
  s3ArtifactsBucket?: string;
  s3TracesClient?: S3StorageService;
  s3TracesBucket?: string;
  s3WorkspacesClient?: S3StorageService;
  s3WorkspacesBucket?: string;
}) => {
  const [db, s3Artifacts, s3Traces, s3Workspaces] = await Promise.all([
    buildDbStatus(),
    buildS3Status(deps.s3ArtifactsClient, deps.s3ArtifactsBucket),
    buildS3Status(deps.s3TracesClient, deps.s3TracesBucket),
    buildS3Status(deps.s3WorkspacesClient, deps.s3WorkspacesBucket),
  ]);
  return { db, s3Artifacts, s3Traces, s3Workspaces };
};
