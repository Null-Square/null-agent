export type WorkspaceAllocationKind = 'session' | 'run';

export type WorkspaceOwnerKind = WorkspaceAllocationKind;

export interface WorkspaceOwner {
  kind: WorkspaceOwnerKind;
  id: string;
}

export interface WorkspaceAllocationOptions {
  kind?: WorkspaceAllocationKind;
}

export interface WorkspaceOrphanCleanupOptions {
  minAgeMs?: number;
  isOwnerActive(owner: WorkspaceOwner): Promise<boolean>;
}

export interface WorkspaceOrphanCleanupResult {
  found: number;
  reaped: number;
  skippedActive: number;
  skippedYoung: number;
  errors: number;
  reapedWorkspaces: string[];
}

export interface WorkspaceSnapshotManifest {
  schemaVersion: 1;
  ownerId: string;
  snapshotId: string;
  createdAt: string;
  directoryHash: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface WorkspaceManager {
  /**
   * Reserve a workspace path. Run-scoped sessions use kind=run and the run id as ownerId.
   * Non-run sessions keep kind=session and the session id as ownerId.
   */
  allocateWorkspace(ownerId: string, options?: WorkspaceAllocationOptions): string;

  /**
   * Ensure the workspace exists and is ready for use (mkdir, set permissions, quotas, etc).
   */
  ensureWorkspace(workspaceDir: string, sessionId?: string): Promise<void>;

  /**
   * Enforce any configured quotas (size, age, etc). Should throw or return false when over limit.
   */
  enforceQuota?(workspaceDir: string): Promise<boolean>;

  /**
   * Cleanup a workspace directory. Implementations should be resilient to missing paths.
   */
  cleanupWorkspace(workspaceDir: string, sessionId?: string): Promise<void>;

  /**
   * Cleanup stale workspaces older than the provided TTL (ms). Returns the number removed.
   */
  cleanupStaleWorkspaces?(ttlMs: number): Promise<number>;

  /**
   * Cleanup inactive ns-agent-* / ns-run-* workspace directories after checking
   * ownership against the durable session/run model.
   */
  cleanupOrphanedWorkspaces?(options: WorkspaceOrphanCleanupOptions): Promise<WorkspaceOrphanCleanupResult>;

  /**
   * Return lightweight metrics about workspace hygiene.
   */
  getMetrics?(): {
    cleaned?: number;
    blocked?: number;
    lastCleanupAt?: number;
    lastBlockedAt?: number;
    lastBlockedWorkspace?: string;
  };

  /**
   * Optional restore hook used when a session is hydrated and the workspace is missing.
   */
  restoreWorkspace?(workspaceDir: string, sessionId: string): Promise<void>;

  /** Create an immutable, verified snapshot. The latest pointer is written last. */
  createSnapshot?(workspaceDir: string, ownerId: string): Promise<WorkspaceSnapshotManifest | null>;

  /** Restore the latest immutable snapshot and fail on missing/corrupt content. */
  restoreLatestSnapshot?(workspaceDir: string, ownerId: string): Promise<boolean>;

  /**
   * Optional runtime quota update hook.
   */
  setMaxBytesPerWorkspace?(maxBytes?: number): void;
}
