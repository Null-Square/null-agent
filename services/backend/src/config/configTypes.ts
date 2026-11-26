export type SandboxConfigLayer = {
  cpuQuota?: number;
  memoryMb?: number;
  pidsLimit?: number;
  stdoutLimitBytes?: number;
  image?: string;
  network?: string;
  devUnsafe?: boolean;
  // REMOVED Dec 2025: stageProfile, prodProfile - use single defaultProfile
  user?: string;
  /** Health check interval in ms (default: 30000 = 30 seconds) */
  healthCheckIntervalMs?: number;
  /** Maximum recovery attempts before giving up (default: 2) */
  maxRecoveryAttempts?: number;
  /** Enable proactive container monitoring (default: true) */
  proactiveMonitoring?: boolean;
};

export type RuntimeConfigLayer = {
  /** Injected per-model credentials (DB-backed). */
  apiKey?: string;
  /** Injected per-model base URL (DB-backed). */
  apiBaseUrl?: string;
  turnTimeoutMs: number;
  maxToolCallsPerTurn: number;
  shellTimeoutMs: number;
  webTimeoutMs: number;
  webMaxBytes: number;
  sessionTTLMinutes: number;
};

export type PolicyConfigLayer = {
  verboseLogging?: boolean;
};

export type AutomationConfigLayer = {
  maxGuardRetries: number;
  requireReport: boolean;
  /** Per-turn timeout in milliseconds (default: 300000 = 5 minutes) */
  turnTimeoutMs?: number;
  /** Create checkpoint every N tool calls in automated mode (default: 10, 0 = disabled) */
  checkpointIntervalToolCalls?: number;
  /** Minimum report.md content length for validation (default: 500 chars) */
  reportMinLength?: number;
  /** Enable workspace backup to S3 after tool calls (default: false) */
  workspaceBackupEnabled?: boolean;
};

export type AccessControlConfigLayer = {
  enabled: boolean;
};

export type TraceConfigLayer = {
  traceInlineLimit: number;
  stdoutChunkSize: number;
  traceCompressOverBytes: number;
  traceRetentionDays: number;
  traceLogsRoot: string;
  artifactDirName: string;
  artifactMaxChars: number;
  s3FlushIntervalMs: number;
  s3FlushMaxEvents: number;
  // REMOVED Dec 2025: keepLocalCopy, localMirrorPath - unused
};

export type NetworkConfigLayer = {
  corsAllowedOrigins: string[];
  allowOutbound?: boolean;
  outboundAllowlist?: string[];
};

export type WorkspaceConfigLayer = {
  maxBytesPerWorkspace?: number;
  rootDir: string;
  objectStoreRoot: string;
  artifactStorageRoot: string;
};

export type ManifestsConfigLayer = {
  toolsDir: string;
  toolDevWatch: boolean;
};

export type WebSearchConfigLayer = {
  duckBaseUrl: string;
  duckLiteBaseUrl: string;
  tavilyBaseUrl: string;
  provider: 'duck' | 'tavily';
  maxResults: number;
  tavilyApiKey?: string;
  timeoutMs: number;
  maxBytes: number;
};

export type HttpConfigLayer = {
  logSlowMs: number;
  logDebugSampleRate: number;
  logQuietPaths: string[];
  uploadsMaxBytes: number;
};

/**
 * Session retention config (Gemini-style simple retention)
 * 
 * SIMPLIFIED Dec 2025: Replaced complex archive/purge lifecycle with simple TTL.
 * Old fields (autoArchiveDays, purgeAfterArchiveDays, jobCron) removed.
 */
export type SessionLifecycleConfigLayer = {
  /** Maximum age in days before deletion (default: 30, 0 = never delete) */
  maxAgeDays: number;
  /** Maximum sessions per user (0 = unlimited, default: 0) */
  maxCountPerUser: number;
  /** Enable automatic cleanup (default: true) */
  retentionEnabled: boolean;
};

export type TokenGuardConfigLayer = {
  /** Maximum tokens allowed per session (0 = unlimited, default: 0) */
  perSessionLimit: number;
  /** Maximum tokens allowed per user per day (0 = unlimited, default: 0) */
  perUserDailyLimit: number;
  /** Percentage of limit at which to emit warning (0-100, default: 80) */
  warningThresholdPct: number;
};

export type OobConfigLayer = {
  /** interactsh-compatible server URL. Unset means offline/file fallback mode. */
  interactshServerUrl?: string;
  /** Raw Authorization token used by backend to register/poll the interactsh server. */
  interactshAuthToken?: string;
  /** Public callback domain handed to targets, e.g. oast.example.com. */
  interactshCallbackDomain?: string;
  /** Public callback URL scheme handed to targets. */
  interactshCallbackScheme?: 'http' | 'https';
  /** Poll interval for active OOB tokens. */
  pollIntervalSeconds: number;
  /** Default TTL for issued OOB tokens. */
  tokenDefaultTtlSeconds: number;
  /** Maximum allowed TTL for issued OOB tokens. */
  tokenMaxTtlSeconds: number;
};

export type PerformanceConfigLayer = {
  enabled: boolean;
  prometheusUrl?: string;
  queryTimeoutMs: number;
  maxRangeHours: number;
  queryStepSeconds: number;
  /** Sample `docker stats` during sandbox container life (works without cAdvisor). */
  dockerStatsEnabled: boolean;
  dockerStatsIntervalMs: number;
};


export type ResolvedConfig = {
  sandbox: SandboxConfigLayer;
  runtime: RuntimeConfigLayer;
  policy?: PolicyConfigLayer;
  automation: AutomationConfigLayer;
  accessControl: AccessControlConfigLayer;
  trace: TraceConfigLayer;
  network: NetworkConfigLayer;
  workspace: WorkspaceConfigLayer;
  manifests: ManifestsConfigLayer;
  webSearch: WebSearchConfigLayer;
  http: HttpConfigLayer;
  sessionLifecycle: SessionLifecycleConfigLayer;
  tokenGuard: TokenGuardConfigLayer;
  oob: OobConfigLayer;
  performance?: PerformanceConfigLayer;
};

export type ConfigOverrides = Partial<ResolvedConfig>;
