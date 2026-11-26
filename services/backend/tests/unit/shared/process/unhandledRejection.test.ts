import { describe, expect, it } from 'vitest';

import {
  describeUnhandledRejection,
  isExpectedCancellationRejection,
} from '@/shared/process/unhandledRejection';

describe('unhandled rejection classification', () => {
  it('contains only typed cancellation rejections', () => {
    const named = new Error('This operation was aborted');
    named.name = 'AbortError';
    class AbortError extends Error {}
    const claudeSdkShape = new AbortError('Operation aborted');

    expect(isExpectedCancellationRejection(named)).toBe(true);
    expect(claudeSdkShape.name).toBe('Error');
    expect(isExpectedCancellationRejection(claudeSdkShape)).toBe(true);
    expect(isExpectedCancellationRejection({ code: 'ABORT_ERR', message: 'Aborted' })).toBe(true);
    expect(isExpectedCancellationRejection(new Error('aborted'))).toBe(false);
    expect(isExpectedCancellationRejection({ name: 'Error', code: 'FAILED' })).toBe(false);
  });

  it('preserves non-enumerable Error diagnostics for structured logging', () => {
    const reason = Object.assign(new Error('provider cancellation'), { code: 'ABORT_ERR' });

    expect(describeUnhandledRejection(reason)).toEqual({
      type: 'Error',
      name: 'Error',
      code: 'ABORT_ERR',
      message: 'provider cancellation',
    });
  });
});
