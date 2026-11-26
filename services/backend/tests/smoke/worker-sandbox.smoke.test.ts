import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SandboxManager } from '@/domains/agent-brain/adapters/sandbox/SandboxManager';
import type { SessionState } from '@/domains/agent-brain/domain/types';

import { assertDockerReady, buildSession, buildSmokeConfig } from './sandbox/config';
import { COMMAND_TIMEOUT_MS } from './sandbox/constants';
import { makeWorkspaceRemovable } from './sandbox/fixture';

const ENABLED =
  process.env.RUN_SANDBOX_TOOL_SMOKE === '1' ||
  process.env.RUN_TOOL_SMOKE === '1';

const describeSmoke = ENABLED ? describe : describe.skip;

describeSmoke('worker sandbox isolation smoke', () => {
  it('lets scoped workers run managed shell jobs without widening workspace writes', async () => {
    assertDockerReady();

    const workspaceDir = path.join(tmpdir(), `nullai-worker-sandbox-smoke-${randomUUID()}`);
    let manager: SandboxManager | undefined;
    let session: SessionState | undefined;

    try {
      await mkdir(path.join(workspaceDir, '.artifacts', 'report'), { recursive: true });
      await writeFile(path.join(workspaceDir, '.artifacts', 'report', 'existing.txt'), 'readonly-sentinel');

      session = {
        ...buildSession(workspaceDir),
        id: `worker-smoke-${randomUUID()}`,
        flags: {
          securityops: {
            runId: `run-smoke-${randomUUID()}`,
          },
        },
        coordination: {
          role: 'worker',
          parentSessionId: 'parent-smoke',
          parentTaskId: 'task-smoke',
          workerType: 'recon_worker',
          executionMode: 'background',
          dependencyMode: 'sidecar',
          writeScope: ['/workspace/.artifacts/scans/worker-smoke'],
        },
      } as SessionState;

      let storedSession = session;
      const sessionStore = {
        get: (sessionId: string) => (sessionId === storedSession.id ? storedSession : undefined),
        set: (_sessionId: string, next: SessionState) => {
          storedSession = next;
        },
        setAsync: async (_sessionId: string, next: SessionState) => {
          storedSession = next;
        },
        listSessions: () => [storedSession],
      };

      manager = new SandboxManager({
        sessionStore: sessionStore as never,
        config: buildSmokeConfig(),
        policyFacade: {
          resolveSandboxCapabilities: async () => ({
            name: 'tool-smoke',
            privileged: false,
            readonlyRootfs: false,
            network: 'bridge',
            capDrop: [],
            capAdd: [],
            seccomp: null,
            user: 'root',
          }),
        } as never,
      });

      await manager.create(session);

      const result = await manager.startManagedShellJob(
        session,
        [
          'set -eu',
          'printf scoped-write > /workspace/.artifacts/scans/worker-smoke/evidence.txt',
          'printf runtime-cookie > /workspace/.http_sessions/cookie.txt',
          'test -d /workspace/.artifacts/shell-jobs',
          'if sh -c "printf forbidden > /workspace/forbidden-root.txt" 2>/tmp/root-write.err; then',
          '  echo NULLAI_ROOT_WRITE_UNEXPECTED',
          '  exit 40',
          'fi',
          'if sh -c "printf forbidden > /workspace/.artifacts/report/forbidden.txt" 2>/tmp/report-write.err; then',
          '  echo NULLAI_REPORT_WRITE_UNEXPECTED',
          '  exit 41',
          'fi',
          'test ! -f /workspace/forbidden-root.txt',
          'test ! -f /workspace/.artifacts/report/forbidden.txt',
          'echo NULLAI_WORKER_SCOPE_OK',
        ].join('\n'),
        {
          waitBudgetMs: 30_000,
          hardTimeoutMs: 30_000,
          turnNumber: 1,
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe('completed');
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('NULLAI_WORKER_SCOPE_OK');

      await expect(
        readFile(path.join(workspaceDir, '.artifacts', 'scans', 'worker-smoke', 'evidence.txt'), 'utf8'),
      ).resolves.toBe('scoped-write');
      await expect(
        readFile(path.join(workspaceDir, '.http_sessions', 'cookie.txt'), 'utf8'),
      ).resolves.toBe('runtime-cookie');
      await expect(readFile(path.join(workspaceDir, 'forbidden-root.txt'), 'utf8')).rejects.toThrow();
      await expect(
        readFile(path.join(workspaceDir, '.artifacts', 'report', 'forbidden.txt'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      if (manager && session) {
        await makeWorkspaceRemovable(manager, session).catch(() => undefined);
        await manager.destroy(session).catch(() => undefined);
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, COMMAND_TIMEOUT_MS);
});
