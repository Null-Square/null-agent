import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRafCoalescer } from './coalesce';

describe('createRafCoalescer', () => {
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;

  afterEach(() => {
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: originalRaf,
      configurable: true,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      value: originalCancel,
      configurable: true,
    });
  });

  it('flushes immediately when requestAnimationFrame is unavailable', () => {
    Object.defineProperty(window, 'requestAnimationFrame', { value: undefined, configurable: true });
    Object.defineProperty(window, 'cancelAnimationFrame', { value: undefined, configurable: true });

    const flushEntries = vi.fn();
    const coalescer = createRafCoalescer<string>(flushEntries);

    coalescer.append('msg-1', 'hello');
    expect(flushEntries).toHaveBeenCalledWith([['msg-1', 'hello']]);

    coalescer.append('msg-1', '');
    expect(flushEntries).toHaveBeenCalledTimes(1);
  });

  it('batches updates within a frame and can reset pending flush', () => {
    const callbacks: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    const cancel = vi.fn();

    Object.defineProperty(window, 'requestAnimationFrame', { value: raf, configurable: true });
    Object.defineProperty(window, 'cancelAnimationFrame', { value: cancel, configurable: true });

    const flushEntries = vi.fn();
    const coalescer = createRafCoalescer<string>(flushEntries);

    coalescer.append('tool', 'one');
    coalescer.append('tool', 'two');

    expect(flushEntries).not.toHaveBeenCalled();
    callbacks.forEach((cb) => cb(0));

    expect(flushEntries).toHaveBeenCalledWith([['tool', 'onetwo']]);

    coalescer.append('tool', 'three');
    coalescer.reset();
    expect(cancel).toHaveBeenCalled();
    callbacks.slice(1).forEach((cb) => cb(0));
    expect(flushEntries).toHaveBeenCalledTimes(1);
  });
});
