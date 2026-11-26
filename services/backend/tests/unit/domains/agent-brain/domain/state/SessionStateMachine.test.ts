import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStateMachine } from '@/domains/agent-brain/domain/state';

const createLogger = () => {
  const debug = vi.fn();
  const warn = vi.fn();
  const child = vi.fn(() => ({ debug, warn }));
  const logger = { child } as any;

  return { logger, debug, warn, child };
};

describe('SessionStateMachine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('transitions from idle to processing to idle', () => {
    const { logger, debug } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    expect(sm.getState()).toBe('idle');
    expect(sm.startProcessing('turn_start', 1, 'test')).toBe(true);
    expect(sm.getState()).toBe('processing');
    expect(sm.stopProcessing('turn_complete', 1, 'test')).toBe(true);
    expect(sm.getState()).toBe('idle');
    expect(debug).toHaveBeenCalled();
  });

  it('keeps an approval wait distinct from the next processing turn', () => {
    const { logger } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    sm.startProcessing('turn_start', 1, 'test');
    expect(sm.awaitUser('await_input', 1, 'test')).toBe(true);
    expect(sm.getState()).toBe('awaiting_user');
    expect(sm.stopProcessing('response_recorded', 1, 'test')).toBe(true);
    expect(sm.getState()).toBe('idle');
    expect(sm.startProcessing('next_turn', 2, 'test')).toBe(true);
    expect(sm.getState()).toBe('processing');
  });

  it('rejects invalid transitions', () => {
    const { logger, warn } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    expect(sm.awaitUser('await_input', 1, 'test')).toBe(false);
    expect(sm.getState()).toBe('idle');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'idle', to: 'awaiting_user', reason: 'await_input' }),
      '[StateMachine] Invalid transition rejected',
    );
  });

  it('supports convenience helpers', () => {
    const { logger } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    expect(sm.startProcessing('turn_start')).toBe(true);
    expect(sm.awaitUser('wait')).toBe(true);
    expect(sm.stopProcessing('stop')).toBe(true);
    expect(sm.getState()).toBe('idle');
  });

  it('serializes and restores state', () => {
    const { logger } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    sm.startProcessing('turn_start', 1, 'test');
    const snapshot = sm.toJSON();
    const restored = SessionStateMachine.fromJSON('session-1', snapshot, logger);

    expect(restored.toJSON()).toEqual(snapshot);
    expect(restored.getState()).toBe('processing');
  });

  it('emits debug logs on valid transitions', () => {
    const { logger, debug } = createLogger();
    const sm = new SessionStateMachine('session-1', logger);

    sm.startProcessing('turn_start', 1, 'test');

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'idle', to: 'processing', reason: 'turn_start' }),
      '[StateMachine] State transition',
    );
  });
});
