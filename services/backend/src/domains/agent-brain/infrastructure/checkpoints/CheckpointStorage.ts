import * as fs from 'fs';
import * as path from 'path';
import type { SessionState } from '../../domain/types';

export class CheckpointStorage {
    async ensureCheckpointRoot(session: SessionState): Promise<string> {
        const workspaceDir = session.workspaceDir;
        const baseDir = path.join(path.dirname(workspaceDir), 'ns-checkpoints', session.id);
        await fs.promises.mkdir(baseDir, { recursive: true });
        return baseDir;
    }

    async createCheckpointDir(checkpointsDir: string, checkpointId: string): Promise<string> {
        const checkpointDir = path.join(checkpointsDir, checkpointId);
        await fs.promises.rm(checkpointDir, { recursive: true, force: true });
        await fs.promises.mkdir(checkpointDir, { recursive: true });
        return checkpointDir;
    }

    async copyWorkspaceToCheckpoint(workspaceDir: string, checkpointDir: string): Promise<void> {
        await fs.promises.cp(workspaceDir, checkpointDir, {
            recursive: true,
            dereference: false,
        });
    }

    async restoreCheckpointToWorkspace(checkpointDir: string, workspaceDir: string): Promise<void> {
        await this.clearWorkspace(workspaceDir);
        await fs.promises.cp(checkpointDir, workspaceDir, {
            recursive: true,
        });
    }

    async exists(target: string): Promise<boolean> {
        try {
            await fs.promises.access(target, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    async computeDirectoryStats(root: string): Promise<{ filesCount: number; sizeBytes: number }> {
        let filesCount = 0;
        let sizeBytes = 0;
        const stack: string[] = [root];

        while (stack.length > 0) {
            const current = stack.pop()!;
            const dirents = await fs.promises.readdir(current, { withFileTypes: true });
            for (const dirent of dirents) {
                const fullPath = path.join(current, dirent.name);
                if (dirent.isDirectory()) {
                    stack.push(fullPath);
                } else if (dirent.isFile()) {
                    filesCount += 1;
                    const stats = await fs.promises.stat(fullPath);
                    sizeBytes += stats.size;
                }
            }
        }

        return { filesCount, sizeBytes };
    }

    private async clearWorkspace(workspaceDir: string): Promise<void> {
        const entries = await fs.promises.readdir(workspaceDir);
        for (const entry of entries) {
            const target = path.join(workspaceDir, entry);
            await fs.promises.rm(target, { recursive: true, force: true });
        }
    }
}
