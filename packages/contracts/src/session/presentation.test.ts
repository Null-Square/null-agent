import { describe, expect, it } from 'vitest';
import {
  canAcceptSessionInput,
  resolveSessionActions,
  resolveSessionPresentation,
} from './presentation.js';

describe('canonical session presentation', () => {
  it('gives durable stopped intent precedence over observed work', () => {
    expect(resolveSessionPresentation({
      desiredExecution: 'stopped',
      condition: 'recovering',
    })).toMatchObject({
      kind: 'stopped',
      label: 'STOPPED',
      desiredExecution: 'stopped',
      condition: 'recovering',
    });
    expect(resolveSessionActions({
      desiredExecution: 'stopped',
      condition: 'recovering',
    })).toEqual({ showStop: false, showStart: true });
  });

  it.each([
    ['executing', 'running', 'RUNNING'],
    ['recovering', 'recovering', 'RECOVERING'],
    ['waiting_approval', 'waiting_approval', 'WAITING FOR APPROVAL'],
    ['waiting_credits', 'waiting_credits', 'WAITING FOR CREDITS'],
    ['waiting_runner', 'waiting_runner', 'WAITING FOR RUNNER'],
    ['waiting_prerequisite', 'waiting_prerequisite', 'WAITING'],
    ['completed', 'completed', 'COMPLETED'],
    ['idle', 'idle', 'IDLE'],
  ] as const)('maps %s to %s', (condition, kind, label) => {
    expect(resolveSessionPresentation({
      desiredExecution: 'running',
      condition,
    })).toMatchObject({ kind, label });
  });

  it('derives Stop/Start/Upgrade from the canonical pair only', () => {
    expect(resolveSessionActions({
      desiredExecution: 'running',
      condition: 'recovering',
    })).toEqual({ showStop: true, showStart: false });
    expect(resolveSessionActions({
      desiredExecution: 'running',
      condition: 'waiting_credits',
    })).toEqual({ showStop: true, showStart: false });
    expect(resolveSessionActions({
      desiredExecution: 'running',
      condition: 'completed',
    })).toEqual({ showStop: false, showStart: true });
  });

  it('labels provider quota as an existing prerequisite rather than a new lifecycle state', () => {
    expect(resolveSessionPresentation({
      desiredExecution: 'running',
      condition: 'waiting_prerequisite',
      conditionReason: 'provider_quota_exhausted',
    })).toMatchObject({
      kind: 'waiting_prerequisite',
      label: 'WAITING FOR SUBSCRIPTION LIMIT',
      shortLabel: 'SUBSCRIPTION LIMIT',
    });
  });

  it('allows input only when stopped, idle, or completed', () => {
    expect(canAcceptSessionInput({ desiredExecution: 'stopped', condition: 'recovering' })).toBe(true);
    expect(canAcceptSessionInput({ desiredExecution: 'running', condition: 'idle' })).toBe(true);
    expect(canAcceptSessionInput({ desiredExecution: 'running', condition: 'completed' })).toBe(true);
    expect(canAcceptSessionInput({ desiredExecution: 'running', condition: 'executing' })).toBe(false);
    expect(canAcceptSessionInput({ desiredExecution: 'running', condition: 'waiting_credits' })).toBe(false);
  });

  it('does not surface legacy failed/error/cancelled as session terminal states', () => {
    expect(resolveSessionPresentation({ status: 'failed' }).kind).toBe('idle');
    expect(resolveSessionPresentation({ status: 'error' }).kind).toBe('idle');
    expect(resolveSessionPresentation({
      status: 'paused',
      blockedReason: 'aborted_by_user',
    }).kind).toBe('stopped');
  });

  it('preserves safe recovery detail for legacy system-pause compatibility', () => {
    expect(resolveSessionPresentation({
      status: 'paused',
      pauseReason: 'system',
      blockedReason: 'system_paused',
      blockedMetaCode: 'closeout_pending',
    })).toMatchObject({
      kind: 'recovering',
      systemPauseCauseCode: 'closeout_pending',
      systemPauseCauseLabel: 'report finalization is still in progress',
    });
  });
});
