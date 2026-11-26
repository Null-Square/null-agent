import { describe, expect, it, vi } from 'vitest';
import { sessionLogger } from './sessionLogger';

describe('sessionLogger', () => {
  it('logs only when debug is enabled', () => {
    const enabled = sessionLogger.isEnabled();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    sessionLogger.optimisticPatch('s1', { status: 'running' }, 'update');

    if (enabled) {
      expect(logSpy).toHaveBeenCalled();
    } else {
      expect(logSpy).not.toHaveBeenCalled();
    }

    logSpy.mockRestore();
  });
});
