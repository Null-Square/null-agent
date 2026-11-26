import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CheckpointManager } from '@/domains/agent-brain/application/core/CheckpointManager';

const storageMocks = vi.hoisted(() => ({
  ensureCheckpointRoot: vi.fn(),
  createCheckpointDir: vi.fn(),
  copyWorkspaceToCheckpoint: vi.fn(),
  computeDirectoryStats: vi.fn(),
  exists: vi.fn(),
  restoreCheckpointToWorkspace: vi.fn(),
}));

vi.mock('@/domains/agent-brain/infrastructure/checkpoints/CheckpointStorage', () => ({
  CheckpointStorage: class {
    ensureCheckpointRoot = storageMocks.ensureCheckpointRoot;
    createCheckpointDir = storageMocks.createCheckpointDir;
    copyWorkspaceToCheckpoint = storageMocks.copyWorkspaceToCheckpoint;
    computeDirectoryStats = storageMocks.computeDirectoryStats;
    exists = storageMocks.exists;
    restoreCheckpointToWorkspace = storageMocks.restoreCheckpointToWorkspace;
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'checkpoint-1'),
}));

describe('CheckpointManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates checkpoints and records metadata', async () => {
    const session = { id: 'session-1', workspaceDir: '/tmp/ws', turn: 3 } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      addCheckpoint: vi.fn(),
    } as any;
    const streamBroker = { emit: vi.fn() } as any;
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) } as any;

    storageMocks.ensureCheckpointRoot.mockResolvedValue('/checkpoints');
    storageMocks.createCheckpointDir.mockResolvedValue('/checkpoints/checkpoint-1');
    storageMocks.computeDirectoryStats.mockResolvedValue({ filesCount: 2, sizeBytes: 100 });

    const manager = new CheckpointManager(sessionStore, streamBroker, traceRecorder);

    const result = await manager.create('session-1');

    expect(storageMocks.copyWorkspaceToCheckpoint).toHaveBeenCalledWith(
      '/tmp/ws',
      '/checkpoints/checkpoint-1',
    );
    expect(sessionStore.addCheckpoint).toHaveBeenCalledWith('session-1', result);
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'checkpoint_created',
      data: result,
    });
    expect(traceRecorder.write).toHaveBeenCalledWith(
      'session-1',
      4,
      expect.objectContaining({ event: 'checkpoint.created' }),
    );
  });

  it('throws when restoring a missing checkpoint', async () => {
    const session = { id: 'session-1', workspaceDir: '/tmp/ws' } as any;
    const sessionStore = { get: vi.fn().mockReturnValue(session) } as any;
    const streamBroker = { emit: vi.fn() } as any;

    storageMocks.ensureCheckpointRoot.mockResolvedValue('/checkpoints');
    storageMocks.exists.mockResolvedValue(false);

    const manager = new CheckpointManager(sessionStore, streamBroker);

    await expect(manager.restore('session-1', 'missing')).rejects.toThrow(
      'Checkpoint missing not found',
    );
  });

  it('rehydrates metadata when last checkpoint is unknown', async () => {
    const session = { id: 'session-1', workspaceDir: '/tmp/ws', turn: 0 } as any;
    const sessionStore = {
      get: vi.fn().mockReturnValue(session),
      updateLastCheckpoint: vi.fn().mockReturnValue(undefined),
      addCheckpoint: vi.fn(),
    } as any;
    const streamBroker = { emit: vi.fn() } as any;
    const traceRecorder = { write: vi.fn().mockResolvedValue(undefined) } as any;

    storageMocks.ensureCheckpointRoot.mockResolvedValue('/checkpoints');
    storageMocks.exists.mockResolvedValue(true);
    storageMocks.computeDirectoryStats.mockResolvedValue({ filesCount: 1, sizeBytes: 10 });

    const manager = new CheckpointManager(sessionStore, streamBroker, traceRecorder);

    const result = await manager.restore('session-1', 'checkpoint-1');

    expect(storageMocks.restoreCheckpointToWorkspace).toHaveBeenCalledWith(
      expect.stringContaining('checkpoint-1'),
      '/tmp/ws',
    );
    expect(sessionStore.addCheckpoint).toHaveBeenCalledWith('session-1', result);
    expect(streamBroker.emit).toHaveBeenCalledWith('session-1', {
      type: 'checkpoint_restored',
      data: { id: 'checkpoint-1' },
    });
    expect(traceRecorder.write).toHaveBeenCalledWith(
      'session-1',
      1,
      expect.objectContaining({ event: 'checkpoint.restored' }),
    );
  });

  it('lists checkpoints from the session store', async () => {
    const sessionStore = { listCheckpoints: vi.fn().mockReturnValue([{ id: 'cp' }]) } as any;
    const manager = new CheckpointManager(sessionStore, { emit: vi.fn() } as any);

    const result = await manager.list('session-1');

    expect(result).toEqual([{ id: 'cp' }]);
  });
});
