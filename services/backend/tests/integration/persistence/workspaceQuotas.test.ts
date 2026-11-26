import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LocalWorkspaceManager } from '@/domains/agent-brain/adapters/workspace';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import type { WorkspaceManager } from '@/domains/agent-brain/ports';

describe('Workspace quotas (integration)', () => {
  it('blocks session creation when workspace exceeds max bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-quota-'));
    const workspaceDir = path.join(root, 'fixed-workspace');

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'large.txt'), 'x'.repeat(20));

    const baseManager = new LocalWorkspaceManager({ root, maxBytesPerWorkspace: 10 });
    const manager: WorkspaceManager = {
      allocateWorkspace: () => workspaceDir,
      ensureWorkspace: (dir) => baseManager.ensureWorkspace(dir),
      cleanupWorkspace: (dir) => baseManager.cleanupWorkspace(dir),
      enforceQuota: (dir) => baseManager.enforceQuota(dir),
      getMetrics: () => baseManager.getMetrics(),
    };

    const store = new SessionStore({ workspaceManager: manager });

    await expect(store.create({ userId: 'u1', modelName: 'test-model' })).rejects.toThrow(/workspace\.quota_exceeded/);

    await fs.rm(root, { recursive: true, force: true });
  });
});
