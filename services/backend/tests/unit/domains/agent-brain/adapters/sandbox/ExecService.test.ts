import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { ExecService } from '@/domains/agent-brain/adapters/sandbox';
import { FSService } from '@/domains/agent-brain/adapters/sandbox';

describe('ExecService artifact handling', () => {
  it('writes stdout artifact when output exceeds limit and returns tail', async () => {
    const tmpDir = path.join(process.cwd(), 'tmp-exec-test');
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.mkdir(tmpDir, { recursive: true });

    const workspaceDir = path.join(tmpDir, 'ws');
    await fs.mkdir(workspaceDir, { recursive: true });

    const fsService = new FSService({
      resolveRoots: () => ({
        workspaceDir,
        artifactsDir: path.join(workspaceDir, '.artifacts'),
      }),
    });

    const docker = {
      exec: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', // 26 chars
        stderr: '',
        bytesOut: 26,
        bytesErr: 0,
        timedOut: false,
        aborted: false,
      })),
    } as any;

    const execService = new ExecService({
      docker,
      fs: fsService,
      stdoutLimitBytes: 10,
    });

    const session = { workspaceDir } as any;
    const result = await execService.run({
      session,
      containerId: 'c1',
      cmd: 'echo',
    });

    expect(result.stdout).toBe('QRSTUVWXYZ'); // tail of stdout
    expect(result.artifacts?.stdoutPath).toBeDefined();

    const artifactPath = path.join(workspaceDir, result.artifacts!.stdoutPath!);
    const artifactExists = await fs
      .stat(artifactPath)
      .then(() => true)
      .catch(() => false);
    expect(artifactExists).toBe(true);
  });
});







