import { describe, expect, it, vi } from 'vitest';

import { evaluateLiveWorkerTaskGate } from '@/domains/agent-brain/adapters/tools/builtins/phase/shared';

const task = {
  taskId: '00000000-0000-4000-8000-000000000001',
  parentSessionId: 'parent',
  workerSessionId: 'worker',
  workerType: 'enumeration_worker',
  status: 'completed',
  reason: 'bounded hunt',
  task: 'enumerate one endpoint',
  expectedArtifactType: 'enumeration_result/v1',
  executionMode: 'background',
  continuationMode: 'spawn',
  createdAt: 1,
};

describe('enumeration phase handoff worker gate', () => {
  it('blocks terminal enumeration work until result disposition or acknowledgement', async () => {
    const session = { id: 'parent', workerTasks: [{ ...task }] };
    const ctx = {
      sessionId: 'parent',
      turnNumber: 1,
      sessionStore: { get: vi.fn(() => session) },
      workers: { syncWorkerTasks: vi.fn().mockResolvedValue([]) },
    } as any;
    await expect(evaluateLiveWorkerTaskGate(ctx)).resolves.toMatchObject({
      code: 'undispositioned_enumeration_results',
      suggestedTool: 'submit_enumeration_disposition',
    });

    session.workerTasks[0] = {
      ...task,
      enumerationDisposition: {
        action: 'acknowledge_terminal',
        payloadHash: 'a'.repeat(64),
        terminalStateVersion: 'b'.repeat(64),
        completedAt: 2,
        leadDispositions: [],
        canonicalLeadIds: [],
        validatorEligibleLeadIds: [],
        coverageAcknowledged: false,
        negativeResultsAcknowledged: false,
        terminalReason: 'child failed before a typed result',
      },
    } as any;
    await expect(evaluateLiveWorkerTaskGate(ctx)).resolves.toBeNull();
  });
});
