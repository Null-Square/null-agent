import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  WorkspaceAllocationOptions,
  WorkspaceManager,
  WorkspaceOrphanCleanupOptions,
  WorkspaceOrphanCleanupResult,
} from './WorkspaceManager';
import { reapLocalWorkspaceOrphans } from './workspaceOrphanCleanup';
import { logger } from '@/shared/logger';
import { ensureSandboxWritableDirectory } from './workspacePermissions';

type WorkspaceManagerOptions = {
  root?: string;
  maxBytesPerWorkspace?: number;
};

/**
 * LocalWorkspaceManager handles workspace lifecycle using async fs operations.
 * Designed to be replaced by a distributed/quotas-aware implementation later.
 */
export class LocalWorkspaceManager implements WorkspaceManager {
  private readonly root: string;
  private readonly maxBytesPerWorkspace?: number;
  private cleaned = 0;
  private blocked = 0;
  private lastCleanupAt?: number;
  private lastBlockedAt?: number;
  private lastBlockedWorkspace?: string;
  private readonly log = logger.child({ scope: 'LocalWorkspaceManager' });

  constructor(options: WorkspaceManagerOptions = {}) {
    this.root = options.root ?? os.tmpdir();
    this.maxBytesPerWorkspace = options.maxBytesPerWorkspace;
  }

  allocateWorkspace(ownerId: string, options: WorkspaceAllocationOptions = {}): string {
    const prefix = options.kind === 'run' ? 'ns-run' : 'ns-agent';
    return path.join(this.root, `${prefix}-${ownerId}`);
  }

  async ensureWorkspace(workspaceDir: string): Promise<void> {
    await ensureSandboxWritableDirectory(workspaceDir);
    if (this.maxBytesPerWorkspace && this.maxBytesPerWorkspace > 0) {
      await this.enforceQuota(workspaceDir);
    }
  }

  async cleanupWorkspace(workspaceDir: string): Promise<void> {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    this.cleaned += 1;
    this.lastCleanupAt = Date.now();
  }

  async enforceQuota(workspaceDir: string): Promise<boolean> {
    if (!this.maxBytesPerWorkspace || this.maxBytesPerWorkspace <= 0) {
      return true;
    }
    const size = await this.getDirectorySize(workspaceDir);
    if (size > this.maxBytesPerWorkspace) {
      this.blocked += 1;
      this.lastBlockedAt = Date.now();
      this.lastBlockedWorkspace = workspaceDir;
      throw new Error(`workspace.quota_exceeded:${size}`);
    }
    return true;
  }

  /**
   * Remove stale workspaces older than the provided TTL. Returns count removed.
   */
  async cleanupStaleWorkspaces(ttlMs: number): Promise<number> {
    if (ttlMs <= 0) {
      return 0;
    }
    const now = Date.now();
    let removed = 0;
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('ns-agent-') && !entry.name.startsWith('ns-run-')) continue;
        const fullPath = path.join(this.root, entry.name);
        const stats = await fs.stat(fullPath);
        const age = now - stats.mtimeMs;
        if (age > ttlMs) {
          await fs.rm(fullPath, { recursive: true, force: true });
          removed += 1;
        }
      }
    } catch (error) {
      this.log.warn({ err: error }, '[LocalWorkspaceManager] Failed to cleanup stale workspaces');
    }
    if (removed > 0) {
      this.cleaned += removed;
      this.lastCleanupAt = Date.now();
    }
    return removed;
  }

  async cleanupOrphanedWorkspaces(
    options: WorkspaceOrphanCleanupOptions,
  ): Promise<WorkspaceOrphanCleanupResult> {
    return reapLocalWorkspaceOrphans({
      root: this.root,
      minAgeMs: options.minAgeMs,
      isOwnerActive: options.isOwnerActive,
      cleanupWorkspace: async (workspaceDir) => {
        await this.cleanupWorkspace(workspaceDir);
      },
      log: this.log,
    });
  }

  getMetrics() {
    return {
      cleaned: this.cleaned,
      blocked: this.blocked,
      lastCleanupAt: this.lastCleanupAt,
      lastBlockedAt: this.lastBlockedAt,
      lastBlockedWorkspace: this.lastBlockedWorkspace,
    };
  }

  private async getDirectorySize(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        total += await this.getDirectorySize(full);
      } else {
        total += stat.size;
      }
    }
    return total;
  }
}
