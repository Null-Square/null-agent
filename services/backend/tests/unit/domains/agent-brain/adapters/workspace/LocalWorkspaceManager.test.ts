import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LocalWorkspaceManager } from '@/domains/agent-brain/adapters/workspace';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspaces-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('LocalWorkspaceManager', () => {
  it('allocates deterministic workspace paths', () => {
    const manager = new LocalWorkspaceManager({ root: tempRoot });

    const pathA = manager.allocateWorkspace('abc');
    const runPath = manager.allocateWorkspace('run-1', { kind: 'run' });

    expect(pathA).toBe(path.join(tempRoot, 'ns-agent-abc'));
    expect(runPath).toBe(path.join(tempRoot, 'ns-run-run-1'));
  });

  it('creates and cleans up workspaces', async () => {
    const manager = new LocalWorkspaceManager({ root: tempRoot });
    const workspaceDir = manager.allocateWorkspace('session-1');

    await manager.ensureWorkspace(workspaceDir);
    await expect(fs.stat(workspaceDir)).resolves.toBeTruthy();

    await manager.cleanupWorkspace(workspaceDir);
    await expect(fs.stat(workspaceDir)).rejects.toThrow();
  });

  it('enforces workspace quota and tracks metrics', async () => {
    const manager = new LocalWorkspaceManager({ root: tempRoot, maxBytesPerWorkspace: 3 });
    const workspaceDir = manager.allocateWorkspace('session-2');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'big.txt'), '1234');

    await expect(manager.enforceQuota(workspaceDir)).rejects.toThrow('workspace.quota_exceeded');

    const metrics = manager.getMetrics();
    expect(metrics.blocked).toBe(1);
    expect(metrics.lastBlockedWorkspace).toBe(workspaceDir);
  });

  it('cleans stale workspaces by TTL', async () => {
    const manager = new LocalWorkspaceManager({ root: tempRoot });
    const oldDir = manager.allocateWorkspace('old');
    const freshDir = manager.allocateWorkspace('fresh');
    const oldRunDir = manager.allocateWorkspace('old-run', { kind: 'run' });
    const otherDir = path.join(tempRoot, 'misc');

    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(oldRunDir, { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });

    const past = new Date(Date.now() - 10_000);
    await fs.utimes(oldDir, past, past);
    await fs.utimes(oldRunDir, past, past);

    const removed = await manager.cleanupStaleWorkspaces(5_000);

    expect(removed).toBe(2);
    await expect(fs.stat(oldDir)).rejects.toThrow();
    await expect(fs.stat(oldRunDir)).rejects.toThrow();
    await expect(fs.stat(freshDir)).resolves.toBeTruthy();
    await expect(fs.stat(otherDir)).resolves.toBeTruthy();
  });
});
