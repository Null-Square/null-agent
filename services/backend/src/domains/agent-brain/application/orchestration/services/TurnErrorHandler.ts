/**
 * TurnErrorHandler - Handles abort and error cases during turn execution
 * 
 * Responsibilities:
 * - Processing abort signals (user-initiated or system-initiated)
 * - Processing general errors during turn execution
 * - Updating session state via FSM
 * - Emitting appropriate SSE events
 * - Recording error traces
 * 
 * Extracted from OrchestratorAdapter to improve maintainability.
 */

import { logger } from '@/shared/logger';
import { opsMetrics } from '@/shared/metrics/opsMetrics';
import { summarizeForNote } from '@/shared/utils/text';
import type { Message, SessionState } from '../../../domain/types';
import type { SessionStore } from '../../core/SessionStore';
import type { SessionTraceRecorder } from '../../../infrastructure/telemetry';
import { stopProcessing } from '../utils/sessionProcessing';
import { isAppError } from '../../../domain/errors';

// summarizeForNote imported from @/shared/utils/text

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

/** Stream interface for emitting error events */
export interface TurnErrorStream {
    aborted(reason: string): void;
    done(): void;
    raw(type: string, data: unknown): void;
    message(msg: Message): void;
}

/** Result of error handling */
export interface TurnErrorResult {
    status: 'abort' | 'error';
    doneEmitted: boolean;
}

/** Dependencies for TurnErrorHandler */
export interface TurnErrorHandlerDeps {
    sessionStore: SessionStore;
    traceRecorder?: SessionTraceRecorder;
}

/**
 * Check if an error is an AbortError (from AbortController).
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
        return true;
    }
    if (error instanceof Error) {
        if (error.name === 'AbortError') return true;
        if (isRecord(error) && error['code'] === 'ABORT_ERR') return true;
        if (error.message?.includes('aborted')) return true;
    }
    if (isRecord(error) && error['name'] === 'AbortError') {
        return true;
    }
    return false;
}

/**
 * TurnErrorHandler processes errors and aborts during turn execution.
 */
export class TurnErrorHandler {
    private readonly log = logger.child({ scope: 'TurnErrorHandler' });

    constructor(private readonly deps: TurnErrorHandlerDeps) { }

    /**
     * Handle an abort error (user or system initiated abort).
     */
    async handleAbort(params: {
        sessionId: string;
        error: unknown;
        sessionState?: SessionState;
        turnNumber: number;
        turnStream: TurnErrorStream;
        recorder?: SessionTraceRecorder;
        doneEmitted: boolean;
    }): Promise<TurnErrorResult> {
        const { sessionId, sessionState, turnNumber, turnStream, recorder, doneEmitted } = params;

        // Use simple abort reason if available in session
        const reason = 'Aborted by operator.';
        const alreadyEmitted = false; // Simplified - just emit abort event

        if (!alreadyEmitted) {
            turnStream.aborted(reason);
            await this.deps.sessionStore.markAbortEventEmittedAsync(sessionId, reason);
        }

        let finalDoneEmitted = doneEmitted;
        if (!doneEmitted) {
            turnStream.done();
            finalDoneEmitted = true;
        }

        // P0 FIX (Dec 2025): Do NOT inject abort as assistant message
        // Abort is already communicated via:
        // 1. SSE: turnStream.aborted(reason) - sent above
        // 2. Traces: recorder.write() - recorded below
        // Storing it in history pollutes the conversation and breaks alternation invariant
        // Frontend shows "paused" state from SSE event, not from chat message

        if (recorder) {
            await recorder.write(sessionId, turnNumber, {
                event: 'abort',
                severity: 'warn',
                payload: { reason },
                note: summarizeForNote(reason),
            });
        }

        // Use stateMachine for state transitions (single source of truth)
        if (sessionState) {
            sessionState.turn = turnNumber;
            if (sessionState.stateMachine?.getState?.() !== 'idle') {
                stopProcessing(sessionState, {
                    reason: 'abort',
                    turnNumber,
                    caller: 'TurnErrorHandler',
                });
            }
            await this.deps.sessionStore.setAsync(sessionId, sessionState, 'abort');
        }

        return { status: 'abort', doneEmitted: finalDoneEmitted };
    }

    /**
     * Handle a general error during turn execution.
     */
    async handleError(params: {
        sessionId: string;
        error: unknown;
        sessionState?: SessionState;
        turnNumber: number;
        turnStream: TurnErrorStream;
        recorder?: SessionTraceRecorder;
    }): Promise<TurnErrorResult> {
        const { sessionId, error, sessionState, turnNumber, turnStream, recorder } = params;
        const err = error as Error;

        // Credits exhausted and transient provider/network interruptions are expected
        // recoverable conditions. Keep first-attempt logs actionable without paging as
        // internal crashes; TurnFailurePolicy decides retry vs blocked state.
        const isCreditsExhausted = err.message?.includes('Credits exhausted') || err.message?.includes('Insufficient credits');
        if (isCreditsExhausted) {
            this.log.warn({ err, sessionId }, 'Turn halted: credits exhausted');
        } else if (isAppError(error) && error.retryable && (error.inDomain('llm') || error.inDomain('network'))) {
            this.log.warn({ err, sessionId }, 'Transient provider/network error processing message');
        } else {
            this.log.error({ err, sessionId }, 'Error processing message');
        }

        // Record error category for metrics (timeout, rate_limit, auth, etc.)
        opsMetrics.recordApiError(error, sessionId);

        if (isCreditsExhausted) {
            turnStream.raw('credits_exhausted', {
                sessionId,
                creditsRemaining: 0,
                message: err.message,
            });
        } else {
            turnStream.raw('error', {
                code: 'PROCESSING_ERROR',
                message: err.message || 'An error occurred while processing the message',
            });
        }

        if (recorder) {
            await recorder.write(sessionId, turnNumber, {
                event: 'error',
                severity: 'error',
                payload: {
                    message: err.message,
                    stack: err.stack,
                    class: 'process',
                },
                note: summarizeForNote(err.message || 'process error'),
            });
        }

        // Use stateMachine for state transitions (single source of truth)
        if (sessionState) {
            sessionState.turn = turnNumber;
            if (sessionState.stateMachine?.getState?.() !== 'idle') {
                stopProcessing(sessionState, {
                    reason: 'error',
                    turnNumber,
                    caller: 'TurnErrorHandler',
                });
            }
            await this.deps.sessionStore.setAsync(sessionId, sessionState, 'error');
        }

        return { status: 'error', doneEmitted: false };
    }
}
