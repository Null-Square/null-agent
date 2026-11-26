import { describe, expect, it } from 'vitest';
import {
  canAcceptInput,
  getStatusActions,
  getStatusDisplay,
  isSessionBusy,
  isSessionComplete,
  isSessionPaused,
  resolveEffectiveSessionRuntime,
} from './sessionStateUtils';

describe('sessionStateUtils canonical execution projection', () => {
  it('renders the backend-owned pair without consulting live browser flags', () => {
    expect(getStatusDisplay({
      desiredExecution: 'running',
      condition: 'recovering',
    }).label).toBe('RECOVERING');

    expect(resolveEffectiveSessionRuntime({
      desiredExecution: 'stopped',
      condition: 'recovering',
      status: 'running',
      isProcessing: true,
    })).toMatchObject({
      desiredExecution: 'stopped',
      condition: 'recovering',
      status: 'paused',
      pauseReason: 'manual',
      isActivelyProcessing: false,
    });
  });

  it('derives controls only from desired execution and condition', () => {
    expect(getStatusActions({
      desiredExecution: 'running',
      condition: 'executing',
    })).toMatchObject({ showStop: true, showStart: false });

    expect(getStatusActions({
      desiredExecution: 'stopped',
      condition: 'idle',
    })).toMatchObject({ showStop: false, showStart: true });
  });

  it('keeps predicates aligned with the canonical pair', () => {
    expect(isSessionBusy({ desiredExecution: 'running', condition: 'executing' })).toBe(true);
    expect(isSessionPaused({ desiredExecution: 'stopped', condition: 'idle' })).toBe(true);
    expect(isSessionComplete({ desiredExecution: 'running', condition: 'completed' })).toBe(true);
    expect(canAcceptInput({ desiredExecution: 'running', condition: 'idle' })).toBe(true);
    expect(canAcceptInput({ desiredExecution: 'running', condition: 'recovering' })).toBe(false);
  });
});
