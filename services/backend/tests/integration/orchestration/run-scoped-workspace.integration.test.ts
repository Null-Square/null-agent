import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';

import { LocalWorkspaceManager } from '@/domains/agent-brain/adapters/workspace';
import { SessionStore } from '@/domains/agent-brain/application/core/SessionStore';
import { WorkerDelegationService } from '@/domains/agent-brain/application/services/WorkerDelegationService';
import { ToolPolicyChecker } from '@/domains/agent-brain/application/tools/ToolPolicyChecker';

describe('run-scoped shared workspace integration', () => {
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nullai-run-workspace-'));
    store = new SessionStore({
      workspaceManager: new LocalWorkspaceManager({ root }),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lets worker evidence stay directly readable by the parent without a handoff copy', async () => {
    const parent = await store.create({
      userId: 'user-1',
      mode: 'automated',
      agentType: 'executor',
      modelName: 'gpt-5.4',
      flags: {
        securityops: { runId: 'run-shared-1' },
      },
      toolPolicy: {
        allow: ['file_read', 'shell_run', 'submit_worker_result', 'spawn_worker', 'wait_for_worker'],
      },
    });
    await fs.writeFile(path.resolve(parent.workspaceDir, '.credentials'), 'TOKEN=shared\n', 'utf8');

    const initializeSession = vi.fn().mockResolvedValue(undefined);
    const processMessage = vi.fn(async (sessionId: string) => {
      const child = store.get(sessionId)!;
      expect(child.workspaceDir).toBe(parent.workspaceDir);
      await fs.mkdir(path.resolve(child.workspaceDir, '.artifacts', 'scans', 'task-1'), { recursive: true });
      await fs.writeFile(
        path.resolve(child.workspaceDir, '.artifacts', 'scans', 'task-1', 'httpx.jsonl'),
        '{"url":"https://app.example.com"}\n',
        'utf8',
      );
      await expect(fs.readFile(path.resolve(child.workspaceDir, '.credentials'), 'utf8')).resolves.toContain('TOKEN=shared');
      child.workerResult = {
        taskId: child.coordination!.parentTaskId!,
        workerType: child.coordination!.workerType!,
        summary: 'Mapped shared scan evidence.',
        findings: [],
        evidenceRefs: ['/workspace/.artifacts/scans/task-1/httpx.jsonl'],
        touchedTargets: ['app.example.com'],
        confidence: 0.8,
      };
      child.completed = true;
      child.flags = { ...(child.flags ?? {}), session: { completed: true } };
      await store.setAsync(child.id, child, 'integration.worker.completed');
    });

    const service = new WorkerDelegationService(store, new ToolPolicyChecker());
    service.bindRuntime({
      agentEngine: { initializeSession } as any,
      orchestrator: { processMessage } as any,
    });

    const result = await service.spawnWorker({
      parentSessionId: parent.id,
      workerType: 'recon_worker',
      task: 'Map the public HTTP surface.',
      reason: 'Need a bounded recon pass.',
      executionMode: 'blocking',
      writeScope: ['/workspace/.artifacts/scans/task-1'],
    });

    expect(result.artifact?.evidenceRefs).toEqual(['/workspace/.artifacts/scans/task-1/httpx.jsonl']);
    await expect(
      fs.readFile(path.resolve(parent.workspaceDir, '.artifacts', 'scans', 'task-1', 'httpx.jsonl'), 'utf8'),
    ).resolves.toContain('app.example.com');
    await expect(
      fs.stat(path.resolve(parent.workspaceDir, '.artifacts', 'worker-' + 'handoffs')),
    ).rejects.toThrow();
  });
});
