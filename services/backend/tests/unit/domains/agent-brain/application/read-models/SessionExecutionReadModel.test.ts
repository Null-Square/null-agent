import { describe, expect, it } from 'vitest';

import {
  projectLegacySessionExecutionReadModel,
  projectSessionExecutionReadModel,
} from '@/domains/agent-brain/application/read-models/SessionExecutionReadModel';

const now = new Date('2026-08-29T12:00:00.000Z');

const facts = (overrides: {
  desiredExecution?: 'running' | 'stopped';
  isCompleted?: boolean;
  pendingApprovalActionId?: string;
  hasUnfinishedWork?: boolean;
  lastDeferredReason?: string;
  completed?: boolean;
  blockedReason?: string | null;
  executionClaimToken?: string | null;
  executionClaimExpiresAt?: Date | null;
} = {}) => ({
  fold: {
    desiredExecution: overrides.desiredExecution ?? 'running',
    isCompleted: overrides.isCompleted ?? false,
    pendingApprovalActionId: overrides.pendingApprovalActionId,
    hasUnfinishedWork: overrides.hasUnfinishedWork ?? false,
    lastDeferredReason: overrides.lastDeferredReason,
  },
  coordination: {
    sessionId: 'session-1',
    completed: overrides.completed ?? false,
    blockedReason: overrides.blockedReason ?? null,
    nextAttemptAt: null,
    executionClaimToken: overrides.executionClaimToken ?? null,
    executionClaimExpiresAt: overrides.executionClaimExpiresAt ?? null,
  },
});

describe('projectSessionExecutionReadModel', () => {
  it('separates stopped intent from the recoverable underlying condition', () => {
    expect(projectSessionExecutionReadModel(facts({
      desiredExecution: 'stopped',
      hasUnfinishedWork: true,
      blockedReason: 'user_paused',
    }), now)).toEqual({
      desiredExecution: 'stopped',
      condition: 'idle',
    });
  });

  it('uses a durable unexpired claim as the only executing signal', () => {
    expect(projectSessionExecutionReadModel(facts({
      hasUnfinishedWork: true,
      executionClaimToken: 'claim-1',
      executionClaimExpiresAt: new Date('2026-08-29T12:01:00.000Z'),
    }), now).condition).toBe('executing');

    expect(projectSessionExecutionReadModel(facts({
      hasUnfinishedWork: true,
      executionClaimToken: 'claim-1',
      executionClaimExpiresAt: new Date('2026-08-29T11:59:59.000Z'),
    }), now).condition).toBe('recovering');
  });

  it('projects recoverable unfinished work without inventing it from an error marker', () => {
    expect(projectSessionExecutionReadModel(facts({
      hasUnfinishedWork: true,
      blockedReason: 'error',
    }), now)).toMatchObject({ condition: 'recovering' });

    expect(projectSessionExecutionReadModel(facts({
      blockedReason: 'error',
    }), now)).toEqual({
      desiredExecution: 'running',
      condition: 'idle',
    });
  });

  it.each([
    ['awaiting_approval', 'waiting_approval'],
    ['credits_exhausted', 'waiting_credits'],
    ['runner_unavailable', 'waiting_runner'],
    ['guard_exhausted', 'waiting_prerequisite'],
    ['provider_quota_exhausted', 'waiting_prerequisite'],
  ] as const)('maps prerequisite %s to %s', (blockedReason, condition) => {
    expect(projectSessionExecutionReadModel(facts({ blockedReason }), now).condition).toBe(condition);
  });

  it('preserves the provider quota reason without creating another execution condition', () => {
    expect(projectSessionExecutionReadModel(facts({
      hasUnfinishedWork: true,
      blockedReason: 'provider_quota_exhausted',
    }), now)).toEqual({
      desiredExecution: 'running',
      condition: 'waiting_prerequisite',
      conditionReason: 'provider_quota_exhausted',
    });
  });

  it('gives canonical completion precedence over all coordination observations', () => {
    expect(projectSessionExecutionReadModel(facts({
      isCompleted: true,
      hasUnfinishedWork: true,
      blockedReason: 'credits_exhausted',
      executionClaimToken: 'claim-1',
      executionClaimExpiresAt: new Date('2026-08-29T12:01:00.000Z'),
    }), now).condition).toBe('completed');
  });

  it('never promises recovery for a legacy row without journal work', () => {
    expect(projectLegacySessionExecutionReadModel(facts({
      blockedReason: 'error',
    }).coordination, now)).toEqual({
      desiredExecution: 'running',
      condition: 'idle',
    });
  });
});
