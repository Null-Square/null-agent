/**
 * useStreamCoalescer - Manages token/tool stream coalescing with RAF batching
 * 
 * Extracts the coalescing logic from AIChatContext for reuse and testability.
 */

import { useMemo, useCallback } from 'react';
import { createRafCoalescer } from '@modules/chat/store/coalesce';
import { messageActions, toolActions } from '@modules/chat/store/actions';
import type { Dispatch } from '@modules/chat/store/store';

interface UseStreamCoalescerOptions {
    dispatch: Dispatch;
}

interface StreamCoalescerReturn {
    tokenCoalescer: ReturnType<typeof createRafCoalescer<string>>;
    toolCoalescer: ReturnType<typeof createRafCoalescer<string>>;
    flushCoalescedUpdates: () => void;
    resetCoalescers: () => void;
}

/**
 * Creates and manages RAF-batched coalescers for streaming tokens and tool output.
 * This batches rapid updates to avoid overwhelming React's reconciler.
 */
export const useStreamCoalescer = ({ dispatch }: UseStreamCoalescerOptions): StreamCoalescerReturn => {
    const tokenCoalescer = useMemo(
        () =>
            createRafCoalescer<string>((entries) => {
                entries.forEach(([id, chunk]) => {
                    dispatch(messageActions.appendMessageContent(id, chunk));
                });
            }),
        [dispatch],
    );

    const toolCoalescer = useMemo(
        () =>
            createRafCoalescer<string>((entries) => {
                entries.forEach(([toolName, chunk]) => {
                    dispatch(toolActions.appendToolStream(toolName, chunk));
                });
            }),
        [dispatch],
    );

    const flushCoalescedUpdates = useCallback(() => {
        tokenCoalescer.flush();
        toolCoalescer.flush();
    }, [tokenCoalescer, toolCoalescer]);

    const resetCoalescers = useCallback(() => {
        tokenCoalescer.reset();
        toolCoalescer.reset();
    }, [tokenCoalescer, toolCoalescer]);

    return {
        tokenCoalescer,
        toolCoalescer,
        flushCoalescedUpdates,
        resetCoalescers,
    };
};
