import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStreamCoalescer } from './useStreamCoalescer';
import { messageActions, toolActions } from '@modules/chat/store/actions';

describe('useStreamCoalescer', () => {
  it('dispatches batched token and tool updates', () => {
    Object.defineProperty(window, 'requestAnimationFrame', { value: undefined, configurable: true });
    Object.defineProperty(window, 'cancelAnimationFrame', { value: undefined, configurable: true });

    const dispatch = vi.fn();
    const { result } = renderHook(() => useStreamCoalescer({ dispatch }));

    result.current.tokenCoalescer.append('msg-1', 'hello');
    result.current.toolCoalescer.append('shell', 'ls');
    result.current.flushCoalescedUpdates();

    expect(dispatch).toHaveBeenCalledWith(messageActions.appendMessageContent('msg-1', 'hello'));
    expect(dispatch).toHaveBeenCalledWith(toolActions.appendToolStream('shell', 'ls'));

    result.current.resetCoalescers();
  });
});
