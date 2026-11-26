import { describe, expect, it, vi } from 'vitest';
import {
  isAbortError,
  TurnErrorHandler,
} from '@/domains/agent-brain/application/orchestration/services/TurnErrorHandler';

describe('TurnErrorHandler abort classification', () => {
  it('treats an aborted signal as an abort even when the thrown error uses a custom reason', () => {
    const controller = new AbortController();
    controller.abort('operator asked why the scan is taking too long');

    expect(isAbortError(new Error('operator asked why the scan is taking too long'), controller.signal)).toBe(true);
  });

  it('treats named AbortError instances as aborts', () => {
    const error = new Error('custom operator reason');
    error.name = 'AbortError';

    expect(isAbortError(error)).toBe(true);
  });

  it('does not classify ordinary errors as aborts', () => {
    expect(isAbortError(new Error('tool failed'))).toBe(false);
  });
});

describe('TurnErrorHandler prerequisite events', () => {
  it('emits credit exhaustion as a prerequisite instead of a processing error', async () => {
    const handler = new TurnErrorHandler({
      sessionStore: {
        get: vi.fn(),
        setAsync: vi.fn(),
      } as never,
    });
    const turnStream = {
      aborted: vi.fn(),
      done: vi.fn(),
      raw: vi.fn(),
      message: vi.fn(),
    };

    await handler.handleError({
      sessionId: 'session-1',
      error: new Error('Insufficient credits for model call preflight'),
      turnNumber: 2,
      turnStream,
    });

    expect(turnStream.raw).toHaveBeenCalledWith(
      'credits_exhausted',
      expect.objectContaining({ sessionId: 'session-1', creditsRemaining: 0 }),
    );
    expect(turnStream.raw).not.toHaveBeenCalledWith('error', expect.anything());
  });
});
