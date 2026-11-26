/**
 * Bootstrap Configuration
 * 
 * Static configuration loaded from environment variables at module initialization.
 * This is available BEFORE ConfigService.create() completes.
 * 
 * ⚠️ USE ONLY for infrastructure that runs before ConfigService is ready:
 * - Database connection (db/client.ts)
 * - Server startup (AppContainer.ts)
 * - API key validation (apiKeyAuth.ts)
 * 
 * For all application logic, use ResolvedConfig from ConfigService instead.
 * ResolvedConfig merges env vars with DB-backed settings and provides
 * a complete, typed configuration snapshot.
 * 
 * @see configService.ts for runtime configuration
 * @see configTypes.ts for ResolvedConfig type
 */
import './loadDotenv';
import { loadAppConfig } from './configSchema';

const env = loadAppConfig(process.env);

const resolvedPort = env.PORT ?? 3000;

// Export configuration
const appRole = env.APP_ROLE ?? 'api';
const enableWorkers =
  typeof env.ENABLE_WORKERS === 'boolean' ? env.ENABLE_WORKERS : appRole === 'worker';

export const config = {
  port: resolvedPort,
  databaseUrl: env.DATABASE_URL,
  dbPoolMax: Number(env.DB_POOL_MAX ?? 10),
  workspaceRoot: env.WORKSPACE_ROOT,
  workspaceObjectStoreDir: env.WORKSPACE_OBJECT_STORE_DIR,
  nodeEnv: env.NODE_ENV || 'development',
  workspaceMaxBytes: env.WORKSPACE_MAX_BYTES,
  snapshotIntervalMs: env.AGENT_SESSION_SNAPSHOT_INTERVAL_MS,
  s3: {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT, // Browser-accessible endpoint for presigned URLs
    region: env.S3_REGION || 'us-east-1',
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE ?? true,
    autoCreateBuckets: env.S3_AUTO_CREATE_BUCKETS ?? true,
    artifactsBucket: env.S3_BUCKET_ARTIFACTS,
    tracesBucket: env.S3_BUCKET_TRACES,
    workspacesBucket: env.S3_BUCKET_WORKSPACES,
  },
  enableWorkers,
  appRole,
};

// Named export for services that prefer direct access
export { config as env };
export default config;

