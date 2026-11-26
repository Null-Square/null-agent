import { describe, expect, it } from 'vitest';
import {
  canSendMessage,
  getSessionActions,
  isBlockedSession,
  isPausedSession,
  isRunningSession,
  isTerminalSession,
  type SessionMeta,
} from './session';

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1',
  desiredExecution: 'running',
  condition: 'idle',
  createdAt: Date.now(),
  ...overrides,
});

describe('canonical session type helpers', () => {
  it('uses the execution pair instead of legacy status or process flags', () => {
    expect(isRunningSession(session({ condition: 'executing', status: 'idle' }))).toBe(true);
    expect(isRunningSession(session({ condition: 'idle', isProcessing: true }))).toBe(false);
    expect(isPausedSession(session({ desiredExecution: 'stopped', condition: 'recovering' }))).toBe(true);
    expect(isBlockedSession(session({ condition: 'waiting_runner' }))).toBe(true);
    expect(isTerminalSession(session({ condition: 'completed' }))).toBe(true);
    expect(isTerminalSession(session({ status: 'failed', condition: 'idle' }))).toBe(false);
  });

  it('keeps input and actions aligned with the shared presentation contract', () => {
    expect(canSendMessage(session({ condition: 'idle' }))).toBe(true);
    expect(canSendMessage(session({ condition: 'recovering' }))).toBe(false);
    expect(getSessionActions(session({ condition: 'executing' }))).toMatchObject({
      canPause: true,
      canResume: false,
    });
    expect(getSessionActions(session({ desiredExecution: 'stopped' }))).toMatchObject({
      canPause: false,
      canResume: true,
    });
  });
});
