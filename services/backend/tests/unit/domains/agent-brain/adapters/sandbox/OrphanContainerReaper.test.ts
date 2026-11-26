import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrphanContainerReaper, SANDBOX_LABEL } from '@/domains/agent-brain/adapters/sandbox/OrphanContainerReaper';

// Mock DockerDriver
const createMockDocker = () => ({
  listByLabel: vi.fn(),
  destroy: vi.fn(),
});

// Mock SessionRepository
const createMockSessionRepository = () => ({
  findById: vi.fn(),
  listIdsByRunId: vi.fn(),
  findRunLifecycleStatus: vi.fn(),
});

describe('OrphanContainerReaper', () => {
  let mockDocker: ReturnType<typeof createMockDocker>;
  let mockSessionRepo: ReturnType<typeof createMockSessionRepository>;
  let reaper: OrphanContainerReaper;

  beforeEach(() => {
    mockDocker = createMockDocker();
    mockSessionRepo = createMockSessionRepository();
    reaper = new OrphanContainerReaper(mockDocker as never, mockSessionRepo as never);
  });

  describe('reapOrphans', () => {
    it('should return empty result when no sandbox containers exist', async () => {
      mockDocker.listByLabel.mockResolvedValue([]);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(0);
      expect(result.reaped).toBe(0);
      expect(mockDocker.listByLabel).toHaveBeenCalledWith(SANDBOX_LABEL, 'true');
      expect(mockDocker.destroy).not.toHaveBeenCalled();
    });

    it('should keep containers with active sessions', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-1', Names: 'ns-agent-session-abc' },
        { ID: 'container-2', Names: 'ns-agent-session-xyz' },
      ]);
      
      // Both sessions are active (not completed)
      mockSessionRepo.findById.mockImplementation(async (id: string) => ({
        id,
        completed: false,
      }));

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(2);
      expect(result.reaped).toBe(0);
      expect(mockDocker.destroy).not.toHaveBeenCalled();
    });

    it('should reap containers without active sessions', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-orphan', Names: 'ns-agent-session-dead' },
      ]);
      
      // Session doesn't exist
      mockSessionRepo.findById.mockResolvedValue(null);
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(1);
      expect(result.reaped).toBe(1);
      expect(result.reapedContainerIds).toContain('container-orphan');
      expect(mockDocker.destroy).toHaveBeenCalledWith('container-orphan');
    });

    it('should reap containers with ended sessions', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-ended', Names: 'ns-agent-session-finished' },
      ]);
      
      // Session exists but is completed
      mockSessionRepo.findById.mockResolvedValue({
        id: 'session-finished',
        completed: true,
      });
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(1);
      expect(result.reaped).toBe(1);
      expect(mockDocker.destroy).toHaveBeenCalledWith('container-ended');
    });

    it('should handle mixed active and orphan containers', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'active-container', Names: 'ns-agent-active-session' },
        { ID: 'orphan-container', Names: 'ns-agent-dead-session' },
      ]);
      
      mockSessionRepo.findById.mockImplementation(async (id: string) => {
        if (id === 'active-session') {
          return { id, completed: false };
        }
        return null; // dead-session doesn't exist
      });
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(2);
      expect(result.reaped).toBe(1);
      expect(mockDocker.destroy).toHaveBeenCalledWith('orphan-container');
      expect(mockDocker.destroy).not.toHaveBeenCalledWith('active-container');
    });

    it('should keep run-scoped containers with at least one active run session', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'run-container', Names: 'ns-run-run-123' },
      ]);
      mockSessionRepo.listIdsByRunId.mockResolvedValue(['session-complete', 'session-active']);
      mockSessionRepo.findRunLifecycleStatus.mockResolvedValue(null);
      mockSessionRepo.findById.mockImplementation(async (id: string) => ({
        id,
        completed: id !== 'session-active',
      }));

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(1);
      expect(result.reaped).toBe(0);
      expect(mockSessionRepo.listIdsByRunId).toHaveBeenCalledWith('run-123');
      expect(mockDocker.destroy).not.toHaveBeenCalled();
    });

    it('should reap run-scoped containers when all run sessions are complete or missing', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'run-container', Names: ['/ns-run-run-dead'] },
      ]);
      mockSessionRepo.listIdsByRunId.mockResolvedValue(['session-complete', 'session-missing']);
      mockSessionRepo.findRunLifecycleStatus.mockResolvedValue(null);
      mockSessionRepo.findById.mockImplementation(async (id: string) => {
        if (id === 'session-complete') {
          return { id, completed: true };
        }
        return null;
      });
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(1);
      expect(result.reaped).toBe(1);
      expect(result.reapedContainerIds).toContain('run-container');
      expect(mockDocker.destroy).toHaveBeenCalledWith('run-container');
    });

    it('should keep a run-scoped container between completed phase sessions while the run is running', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'run-container', Names: 'ns-run-run-between-phases' },
      ]);
      mockSessionRepo.findRunLifecycleStatus.mockResolvedValue('running');
      mockSessionRepo.listIdsByRunId.mockResolvedValue(['planner-complete', 'recon-complete']);
      mockSessionRepo.findById.mockResolvedValue({ completed: true });

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(1);
      expect(result.reaped).toBe(0);
      expect(mockSessionRepo.findRunLifecycleStatus).toHaveBeenCalledWith('run-between-phases');
      expect(mockSessionRepo.listIdsByRunId).not.toHaveBeenCalled();
      expect(mockDocker.destroy).not.toHaveBeenCalled();
    });

    it.each(['completed', 'failed', 'cancelled'])(
      'should reap a run-scoped container when the run is %s and no session remains active',
      async (status) => {
        mockDocker.listByLabel.mockResolvedValue([
          { ID: 'run-container', Names: 'ns-run-terminal-run' },
        ]);
        mockSessionRepo.findRunLifecycleStatus.mockResolvedValue(status);
        mockSessionRepo.listIdsByRunId.mockResolvedValue(['terminal-session']);
        mockSessionRepo.findById.mockResolvedValue({ completed: true });
        mockDocker.destroy.mockResolvedValue(undefined);

        const result = await reaper.reapOrphans();

        expect(result.reaped).toBe(1);
        expect(mockDocker.destroy).toHaveBeenCalledWith('run-container');
      },
    );

    it('should handle Docker destroy errors gracefully', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-1', Names: 'ns-agent-session-1' },
        { ID: 'container-2', Names: 'ns-agent-session-2' },
      ]);
      mockSessionRepo.findById.mockResolvedValue(null); // Both orphans
      mockDocker.destroy
        .mockRejectedValueOnce(new Error('Docker API error'))
        .mockResolvedValueOnce(undefined);

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(2);
      expect(result.reaped).toBe(1); // Only one succeeded
      expect(result.errors).toBe(1);
    });

    it('should handle container name as array (Docker ps format)', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-1', Names: ['/ns-agent-session-from-array'] },
      ]);
      mockSessionRepo.findById.mockResolvedValue(null);
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.reaped).toBe(1);
      expect(mockSessionRepo.findById).toHaveBeenCalledWith('session-from-array');
    });

    it('should skip containers with unparseable names', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-1', Names: 'some-other-container' }, // Doesn't match pattern
        { ID: 'container-2', Names: 'ns-agent-valid-session' },
      ]);
      mockSessionRepo.findById.mockResolvedValue(null);
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      // Should only process the valid one
      expect(result.reaped).toBe(1);
      expect(mockDocker.destroy).toHaveBeenCalledWith('container-2');
      expect(mockDocker.destroy).not.toHaveBeenCalledWith('container-1');
    });

    it('should preserve containers if session check throws error', async () => {
      mockDocker.listByLabel.mockResolvedValue([
        { ID: 'container-1', Names: 'ns-agent-session-error' },
      ]);
      mockSessionRepo.findById.mockRejectedValue(new Error('DB error'));
      mockDocker.destroy.mockResolvedValue(undefined);

      const result = await reaper.reapOrphans();

      expect(result.reaped).toBe(0);
      expect(mockDocker.destroy).not.toHaveBeenCalled();
    });

    it('should handle Docker listByLabel error gracefully', async () => {
      mockDocker.listByLabel.mockRejectedValue(new Error('Docker not available'));

      const result = await reaper.reapOrphans();

      expect(result.found).toBe(0);
      expect(result.reaped).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('should still run workspace cleanup when Docker listing fails', async () => {
      mockDocker.listByLabel.mockRejectedValue(new Error('Docker not available'));
      const workspaceManager = {
        cleanupOrphanedWorkspaces: vi.fn(async () => ({
          found: 1,
          reaped: 1,
          skippedActive: 0,
          skippedYoung: 0,
          errors: 0,
          reapedWorkspaces: ['/tmp/ns-run-run-old'],
        })),
      };
      reaper = new OrphanContainerReaper(mockDocker as never, mockSessionRepo as never, {
        workspaceManager: workspaceManager as never,
      });

      const result = await reaper.reapOrphans();

      expect(result.workspacesFound).toBe(1);
      expect(result.workspacesReaped).toBe(1);
      expect(workspaceManager.cleanupOrphanedWorkspaces).toHaveBeenCalledTimes(1);
    });

    it('should reap orphan workspaces with inactive owners', async () => {
      mockDocker.listByLabel.mockResolvedValue([]);
      mockSessionRepo.findById.mockResolvedValue(null);
      const workspaceManager = {
        cleanupOrphanedWorkspaces: vi.fn(async ({ isOwnerActive }: any) => {
          expect(await isOwnerActive({ kind: 'session', id: 'dead-session' })).toBe(false);
          return {
            found: 1,
            reaped: 1,
            skippedActive: 0,
            skippedYoung: 0,
            errors: 0,
            reapedWorkspaces: ['/tmp/ns-agent-dead-session'],
          };
        }),
      };
      reaper = new OrphanContainerReaper(mockDocker as never, mockSessionRepo as never, {
        workspaceManager: workspaceManager as never,
      });

      const result = await reaper.reapOrphans();

      expect(result.workspacesFound).toBe(1);
      expect(result.workspacesReaped).toBe(1);
      expect(result.reapedWorkspaces).toEqual(['/tmp/ns-agent-dead-session']);
      expect(workspaceManager.cleanupOrphanedWorkspaces).toHaveBeenCalledTimes(1);
    });

    it('should keep workspace owners active when sessions are recoverably paused', async () => {
      mockDocker.listByLabel.mockResolvedValue([]);
      mockSessionRepo.findById.mockResolvedValue({
        id: 'paused-session',
        completed: false,
        blockedReason: 'system_paused',
        metadata: { blockedMeta: { recoverable: true } },
      });
      const workspaceManager = {
        cleanupOrphanedWorkspaces: vi.fn(async ({ isOwnerActive }: any) => {
          expect(await isOwnerActive({ kind: 'session', id: 'paused-session' })).toBe(true);
          return {
            found: 1,
            reaped: 0,
            skippedActive: 1,
            skippedYoung: 0,
            errors: 0,
            reapedWorkspaces: [],
          };
        }),
      };
      reaper = new OrphanContainerReaper(mockDocker as never, mockSessionRepo as never, {
        workspaceManager: workspaceManager as never,
      });

      const result = await reaper.reapOrphans();

      expect(result.workspacesFound).toBe(1);
      expect(result.workspacesReaped).toBe(0);
      expect(result.workspaceErrors).toBe(0);
    });

    it('should preserve errored session owners even when legacy metadata says non-recoverable', async () => {
      mockDocker.listByLabel.mockResolvedValue([]);
      mockSessionRepo.findById.mockResolvedValue({
        id: 'errored-session',
        completed: false,
        blockedReason: 'error',
        metadata: { blockedMeta: { recoverable: false } },
      });
      const workspaceManager = {
        cleanupOrphanedWorkspaces: vi.fn(async ({ isOwnerActive }: any) => {
          expect(await isOwnerActive({ kind: 'session', id: 'errored-session' })).toBe(true);
          return {
            found: 1,
            reaped: 0,
            skippedActive: 1,
            skippedYoung: 0,
            errors: 0,
            reapedWorkspaces: [],
          };
        }),
      };
      reaper = new OrphanContainerReaper(mockDocker as never, mockSessionRepo as never, {
        workspaceManager: workspaceManager as never,
      });

      const result = await reaper.reapOrphans();

      expect(result.workspacesFound).toBe(1);
      expect(result.workspacesReaped).toBe(0);
      expect(result.workspaceErrors).toBe(0);
    });
  });

  describe('SANDBOX_LABEL constant', () => {
    it('should export the correct label', () => {
      expect(SANDBOX_LABEL).toBe('nullai.sandbox');
    });
  });
});
