import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointStorage } from '@/domains/agent-brain/infrastructure/checkpoints/CheckpointStorage';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-storage-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('CheckpointStorage', () => {
  it('creates checkpoint root next to the workspace', async () => {
    const storage = new CheckpointStorage();
    const workspaceDir = path.join(tempRoot, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    const root = await storage.ensureCheckpointRoot({ id: 'session-1', workspaceDir } as any);

    const expected = path.join(path.dirname(workspaceDir), 'ns-checkpoints', 'session-1');
    expect(root).toBe(expected);
    await expect(fs.stat(root)).resolves.toBeTruthy();
  });

  it('recreates checkpoint directories cleanly', async () => {
    const storage = new CheckpointStorage();
    const baseDir = path.join(tempRoot, 'checkpoints');
    const checkpointDir = path.join(baseDir, 'cp-1');
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(path.join(checkpointDir, 'old.txt'), 'old');

    const result = await storage.createCheckpointDir(baseDir, 'cp-1');

    expect(result).toBe(checkpointDir);
    const entries = await fs.readdir(checkpointDir);
    expect(entries).toEqual([]);
  });

  it('copies and restores workspace contents', async () => {
    const storage = new CheckpointStorage();
    const workspaceDir = path.join(tempRoot, 'workspace');
    const checkpointDir = path.join(tempRoot, 'cp-1');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'a.txt'), 'alpha');

    await storage.copyWorkspaceToCheckpoint(workspaceDir, checkpointDir);
    await expect(fs.readFile(path.join(checkpointDir, 'a.txt'), 'utf-8')).resolves.toBe('alpha');

    await fs.writeFile(path.join(workspaceDir, 'extra.txt'), 'extra');
    await storage.restoreCheckpointToWorkspace(checkpointDir, workspaceDir);

    const entries = await fs.readdir(workspaceDir);
    expect(entries).toEqual(['a.txt']);
  });

  it('reports existence and directory stats', async () => {
    const storage = new CheckpointStorage();
    const statsDir = path.join(tempRoot, 'stats');
    await fs.mkdir(statsDir, { recursive: true });
    await fs.writeFile(path.join(statsDir, 'one.txt'), '123');
    await fs.writeFile(path.join(statsDir, 'two.txt'), 'abcd');

    await expect(storage.exists(statsDir)).resolves.toBe(true);
    await expect(storage.exists(path.join(tempRoot, 'missing'))).resolves.toBe(false);

    const stats = await storage.computeDirectoryStats(statsDir);
    expect(stats).toEqual({ filesCount: 2, sizeBytes: 7 });
  });
});
