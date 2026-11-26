import { describe, expect, it } from 'vitest';

import { assessAttackWorkerToolUse } from '@/domains/agent-brain/domain/workers/attackRuntimeGuard';
import type { SessionState } from '@/domains/agent-brain/domain/types';

const session = {
  coordination: {
    role: 'worker',
    workerType: 'attack_worker',
    maxTargetRequests: 60,
    targetRequestsUsed: 0,
    maxRequestConcurrency: 1,
    activeTargetRequests: 0,
    deadlineAt: Date.now() + 60_000,
  },
  task: {
    vars: {
      mission: {
        attack: {
          schemaVersion: 1,
          kind: 'controlled_exploitation_v1',
          objectiveFamily: 'demonstrate_command_execution',
          objective: 'Marker proof',
          validatedFindingIds: ['finding-1'],
          targetRef: 'https://staging.example.test',
          boundedPaths: ['/vulnerable'],
          allowedImpact: ['create_marker'],
          requestBudget: 60,
          toolBudget: 30,
          timeBudgetSeconds: 600,
          maxRequestConcurrency: 1,
          requiredProof: ['marker'],
          stopConditions: ['done'],
          cleanupPlan: ['remove marker'],
        },
      },
    },
  },
} as unknown as SessionState;

describe('attack worker runtime guard', () => {
  it('meters an exact target and allows state-changing HTTP inside the mission path', () => {
    expect(assessAttackWorkerToolUse(session, 'http_payload', {
      method: 'POST',
      url: 'https://staging.example.test/vulnerable',
    })).toMatchObject({
      targetCapable: true,
      requestCost: 1,
      requestConcurrency: 1,
    });
  });

  it('denies another host and a path outside the bounded mission', () => {
    expect(assessAttackWorkerToolUse(session, 'http_payload', {
      url: 'https://outside.example.test/vulnerable',
    }).blockedReason).toContain('target_scope_denied');
    expect(assessAttackWorkerToolUse(session, 'http_payload', {
      url: 'https://staging.example.test/admin',
    }).blockedReason).toContain('path_scope_denied');
  });

  it('meters shell and Python target-capable calls and enforces request concurrency', () => {
    expect(assessAttackWorkerToolUse(session, 'shell_run', {
      command: 'python3 /workspace/.artifacts/workers/attack/task/poc.py',
    }).requestCost).toBe(1);
    expect(assessAttackWorkerToolUse({
      ...session,
      coordination: { ...session.coordination!, activeTargetRequests: 1 },
    } as SessionState, 'python_session', { code: 'print("cleanup")' }).blockedReason)
      .toBe('attack_worker target_concurrency_exhausted');
  });
});

