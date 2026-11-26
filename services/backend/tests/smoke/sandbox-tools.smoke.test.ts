import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SandboxManager } from '@/domains/agent-brain/adapters/sandbox/SandboxManager';
import type { SessionState } from '@/domains/agent-brain/domain/types';

import { assertDockerReady, buildSession, buildSmokeConfig } from './sandbox/config';
import { COMMAND_TIMEOUT_MS } from './sandbox/constants';
import { makeWorkspaceRemovable, startLocalFixture } from './sandbox/fixture';
import { PHASE_SMOKE_GROUPS } from './sandbox/groups';
import { buildPhaseScript, readToolManifest } from './sandbox/manifest';

const ENABLED =
  process.env.RUN_SANDBOX_TOOL_SMOKE === '1' ||
  process.env.RUN_TOOL_SMOKE === '1';

const describeSmoke = ENABLED ? describe : describe.skip;

describeSmoke('sandbox tool capability smoke', () => {
  const manifest = readToolManifest();
  const manifestByName = new Map(manifest.map((tool) => [tool.name, tool]));
  let workspaceDir: string | undefined;
  let manager: SandboxManager | undefined;
  let session: SessionState | undefined;

  beforeAll(async () => {
    assertDockerReady();

    workspaceDir = await mkdtemp(path.join(tmpdir(), 'nullai-sandbox-tool-smoke-'));
    session = buildSession(workspaceDir);
    const sessionStore = {
      get: (sessionId: string) => (sessionId === session?.id ? session : undefined),
      set: (_sessionId: string, next: SessionState) => {
        session = next;
      },
      setAsync: async (_sessionId: string, next: SessionState) => {
        session = next;
      },
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
    await startLocalFixture(manager, session);
  }, COMMAND_TIMEOUT_MS);

  afterAll(async () => {
    if (manager && session) {
      await makeWorkspaceRemovable(manager, session).catch(() => undefined);
      await manager.destroy(session).catch(() => undefined);
    }
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }, COMMAND_TIMEOUT_MS);

  it('maps every sandbox manifest tool to a phase smoke group', () => {
    const groupedTools = new Set(PHASE_SMOKE_GROUPS.flatMap((group) => group.tools));

    expect(manifest.map((tool) => tool.name).filter((name) => !groupedTools.has(name))).toEqual([]);
    expect([...groupedTools].filter((name) => !manifestByName.has(name))).toEqual([]);
  });

  for (const group of PHASE_SMOKE_GROUPS) {
    it(`passes ${group.phase} sandbox tool checks`, async () => {
      expect(manager).toBeDefined();
      expect(session).toBeDefined();

      const result = await manager!.exec({
        session: session!,
        cmd: buildPhaseScript(group, manifestByName),
        timeoutMs: COMMAND_TIMEOUT_MS,
      });

      expect(`${result.stdout}\n${result.stderr}`).toContain(`NULLAI_PHASE_SMOKE ${group.phase}`);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

      if (group.phase === 'core-runtime') {
        const marker = await readFile(
          path.join(workspaceDir!, '.artifacts', 'smoke', 'workspace.txt'),
          'utf8',
        );
        expect(marker).toBe('NULLAI_WORKSPACE_OK');
      }
    }, COMMAND_TIMEOUT_MS);
  }
});
