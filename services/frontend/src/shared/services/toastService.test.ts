import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toastService } from './toastService';

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  }),
);

vi.mock('sonner', () => ({
  toast: toastMock,
}));

describe('toastService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes status toasts through Sonner with descriptions and actions', () => {
    const retry = vi.fn();

    toastService.error('Failed', 'Try again.', {
      id: 'retry-toast',
      action: {
        label: 'Retry',
        onClick: retry,
      },
    });

    expect(toastMock.error).toHaveBeenCalledWith(
      'Failed',
      expect.objectContaining({
        description: 'Try again.',
        id: 'retry-toast',
      }),
    );

    const options = toastMock.error.mock.calls[0][1];
    options.action.onClick();
    expect(retry).toHaveBeenCalled();
  });

  it('accepts options as the second argument', () => {
    toastService.success('Saved', { duration: 1000 });

    expect(toastMock.success).toHaveBeenCalledWith(
      'Saved',
      expect.objectContaining({
        duration: 1000,
      }),
    );
  });

  it('routes promise toasts through the same service boundary', () => {
    const promise = Promise.resolve(1);
    const success = vi.fn((value: number) => `Done ${value}`);

    toastService.promise(
      promise,
      {
        loading: 'Loading',
        success,
        error: 'Failed',
      },
      { id: 'promise-toast' },
    );

    expect(toastMock.promise).toHaveBeenCalledWith(
      promise,
      expect.objectContaining({
        id: 'promise-toast',
        loading: 'Loading',
        success,
        error: 'Failed',
      }),
    );
  });

  it('handles show without creating an object description', () => {
    toastService.show({ title: 'Heads up' });

    expect(toastMock.info).toHaveBeenCalledWith('Heads up', {});
  });
});
