import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { S3WorkspaceManager } from '@/domains/agent-brain/adapters/workspace';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 's3-workspaces-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

const createS3Stub = () => {
  const objects = new Map<string, Buffer>();
  return {
    listPrefix: vi.fn(async (prefix: string) => [...objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key, relativePath: key.slice(prefix.length) }))),
    getObjectBuffer: vi.fn(async (key: string) => {
      const value = objects.get(key);
      if (!value) throw new Error(`NoSuchKey:${key}`);
      return Buffer.from(value);
    }),
    deletePrefix: vi.fn().mockResolvedValue(undefined),
    uploadFileFromPath: vi.fn().mockResolvedValue(undefined),
    uploadBuffer: vi.fn(async (key: string, buffer: Buffer) => {
      objects.set(key, Buffer.from(buffer));
    }),
    makeKey: vi.fn((...parts: string[]) => parts.filter((part) => part && part.length > 0).join('/')),
    getBucket: vi.fn(() => 'bucket-1'),
    objects,
  } as any;
};

describe('S3WorkspaceManager', () => {
  it('allocates deterministic session and run workspace paths', () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });

    expect(manager.allocateWorkspace('session-1')).toBe(path.join(tempRoot, 'ns-agent-session-1'));
    expect(manager.allocateWorkspace('run-1', { kind: 'run' })).toBe(path.join(tempRoot, 'ns-run-run-1'));
  });

  it('restores workspace contents from S3 objects', async () => {
    const s3 = createS3Stub();
    s3.objects.set('workspaces/session-1/dir/file.txt', Buffer.from('content'));
    const hash = await import('crypto').then(({ createHash }) => createHash('sha256')
      .update('dir/file.txt')
      .update(Buffer.from('content'))
      .digest('hex'));
    s3.objects.set('workspaces/session-1/.hash', Buffer.from(hash));
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const workspaceDir = manager.allocateWorkspace('session-1');

    await manager.restoreWorkspace(workspaceDir, 'session-1');

    const restored = await fs.readFile(path.join(workspaceDir, 'dir', 'file.txt'), 'utf-8');
    expect(restored).toBe('content');
    expect(s3.getObjectBuffer).toHaveBeenCalledWith('workspaces/session-1/dir/file.txt');
    expect(manager.getMetrics().restored).toBe(1);
  });

  it('deduplicates concurrent restore of one run workspace across manager instances', async () => {
    const s3 = createS3Stub();
    s3.objects.set('workspaces/run-shared/dir/file.txt', Buffer.from('content'));
    const hash = await import('crypto').then(({ createHash }) => createHash('sha256')
      .update('dir/file.txt')
      .update(Buffer.from('content'))
      .digest('hex'));
    s3.objects.set('workspaces/run-shared/.hash', Buffer.from(hash));
    const managerA = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const managerB = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const workspaceDir = managerA.allocateWorkspace('run-shared', { kind: 'run' });
    const originalRead = s3.getObjectBuffer.getMockImplementation()!;
    s3.getObjectBuffer.mockImplementation(async (key: string) => {
      if (key.endsWith('/dir/file.txt')) await new Promise((resolve) => setTimeout(resolve, 20));
      return originalRead(key);
    });

    await Promise.all([
      managerA.ensureWorkspace(workspaceDir, 'run-shared'),
      managerB.ensureWorkspace(workspaceDir, 'run-shared'),
    ]);

    await expect(fs.readFile(path.join(workspaceDir, 'dir', 'file.txt'), 'utf8')).resolves.toBe('content');
    expect(managerA.getMetrics().restored + managerB.getMetrics().restored).toBe(1);
    expect(s3.getObjectBuffer).toHaveBeenCalledTimes(2);
  });

  it('persists workspaces to S3 during cleanup', async () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const workspaceDir = manager.allocateWorkspace('session-2');
    await fs.mkdir(path.join(workspaceDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'a.txt'), 'alpha');
    await fs.writeFile(path.join(workspaceDir, 'nested', 'b.txt'), 'beta');

    await manager.cleanupWorkspace(workspaceDir, 'session-2');

    expect(s3.deletePrefix).not.toHaveBeenCalled();
    expect([...s3.objects.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/^workspaces\/session-2\/\.snapshots\/[^/]+\/files\/a\.txt$/),
      expect.stringMatching(/^workspaces\/session-2\/\.snapshots\/[^/]+\/manifest\.json$/),
      'workspaces/session-2/.snapshots/latest.json',
    ]));
    await expect(fs.stat(workspaceDir)).rejects.toThrow();
    expect(manager.getMetrics().persisted).toBe(1);
    expect(manager.getMetrics().cleaned).toBe(1);
  });

  it('keeps the local workspace and previous snapshot when a new snapshot fails', async () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const workspaceDir = manager.allocateWorkspace('run-1', { kind: 'run' });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'state.txt'), 'known-good');
    await manager.createSnapshot(workspaceDir, 'run-1');
    const previousPointer = Buffer.from(s3.objects.get('workspaces/run-1/.snapshots/latest.json')!);

    await fs.writeFile(path.join(workspaceDir, 'state.txt'), 'new-state');
    s3.uploadBuffer.mockImplementationOnce(async () => {
      throw new Error('storage unavailable');
    });
    await expect(manager.cleanupWorkspace(workspaceDir, 'run-1')).rejects.toThrow('storage unavailable');
    await expect(fs.readFile(path.join(workspaceDir, 'state.txt'), 'utf8')).resolves.toBe('new-state');
    expect(s3.objects.get('workspaces/run-1/.snapshots/latest.json')).toEqual(previousPointer);

    await fs.rm(workspaceDir, { recursive: true, force: true });
    await manager.restoreWorkspace(workspaceDir, 'run-1');
    await expect(fs.readFile(path.join(workspaceDir, 'state.txt'), 'utf8')).resolves.toBe('known-good');
  });

  it('fails closed when stored snapshot content does not match its manifest', async () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const workspaceDir = manager.allocateWorkspace('run-2', { kind: 'run' });
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'state.txt'), 'trusted');
    await manager.createSnapshot(workspaceDir, 'run-2');
    const fileKey = [...s3.objects.keys()].find((key: string) => key.endsWith('/files/state.txt'))!;
    s3.objects.set(fileKey, Buffer.from('tampered'));
    await fs.writeFile(path.join(workspaceDir, 'local.txt'), 'preserve-me');

    await expect(manager.restoreWorkspace(workspaceDir, 'run-2')).rejects.toThrow(
      'workspace.snapshot_file_verification_failed',
    );
    await expect(fs.readFile(path.join(workspaceDir, 'local.txt'), 'utf8')).resolves.toBe('preserve-me');
  });

  it('enforces workspace quotas', async () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, {
      localRoot: tempRoot,
      maxBytesPerWorkspace: 3,
    });
    const workspaceDir = manager.allocateWorkspace('session-3');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, 'big.txt'), '1234');

    await expect(manager.enforceQuota(workspaceDir)).rejects.toThrow('workspace.quota_exceeded');
    expect(manager.getMetrics().blocked).toBe(1);
  });

  it('cleans stale local workspaces by TTL', async () => {
    const s3 = createS3Stub();
    const manager = new S3WorkspaceManager(s3, { localRoot: tempRoot });
    const oldDir = manager.allocateWorkspace('old');
    const freshDir = manager.allocateWorkspace('fresh');
    const oldRunDir = manager.allocateWorkspace('old-run', { kind: 'run' });

    await fs.mkdir(oldDir, { recursive: true });
    await fs.mkdir(freshDir, { recursive: true });
    await fs.mkdir(oldRunDir, { recursive: true });

    const past = new Date(Date.now() - 10_000);
    await fs.utimes(oldDir, past, past);
    await fs.utimes(oldRunDir, past, past);

    const removed = await manager.cleanupStaleWorkspaces(5_000);

    expect(removed).toBe(2);
    await expect(fs.stat(oldDir)).rejects.toThrow();
    await expect(fs.stat(oldRunDir)).rejects.toThrow();
    await expect(fs.stat(freshDir)).resolves.toBeTruthy();
  });
});
