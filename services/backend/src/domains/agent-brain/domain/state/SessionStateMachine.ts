/**
 * SessionStateMachine - Centralized session processing state management
 * 
 * Replaces scattered isProcessing flag setters with a proper state machine
 * that enforces valid transitions and provides observability.
 * 
 * @example
 * ```typescript
 * const sm = new SessionStateMachine(sessionId, logger);
 * if (sm.canStartProcessing()) {
 *   sm.startProcessing('turn_start');
 *   // ... do work ...
 *   sm.stopProcessing('turn_complete');
 * }
 * ```
 */

export type SessionStateLogger = {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  child?: (bindings: Record<string, unknown>) => SessionStateLogger;
};

const noopLogger: SessionStateLogger = {
  debug: () => undefined,
  warn: () => undefined,
};

/**
 * Processing states a session can be in.
 * 
 * idle: No work in progress, ready to accept new turns
 * processing: Actively executing a turn (model call, tool execution)
 * awaiting_user: Waiting for an approval-style interaction
 *
 * Operator Stop/Start intent is deliberately not represented here. It is a
 * durable journal fact; this state machine only protects process-local turn
 * execution.
 */
export type SessionProcessingState = 'idle' | 'processing' | 'awaiting_user';

/**
 * Context provided when transitioning states for logging/debugging.
 */
export interface TransitionContext {
  reason: string;
  turnNumber?: number;
  caller?: string;
}

/**
 * Valid state transitions.
 * Map of: fromState -> [valid toStates]
 */
const VALID_TRANSITIONS: Record<SessionProcessingState, SessionProcessingState[]> = {
  idle: ['processing'],
  processing: ['idle', 'awaiting_user'],
  awaiting_user: ['processing', 'idle'],
};

/**
 * SessionStateMachine manages the processing state of a single session.
 * 
 * Thread-safe: State transitions are atomic (single-threaded JS).
 * Observable: All transitions are logged with context.
 * Guarded: Invalid transitions are rejected with warning.
 */
export class SessionStateMachine {
  private state: SessionProcessingState = 'idle';
  private readonly log: SessionStateLogger;
  private lastTransitionTime: number = Date.now();
  private transitionCount: number = 0;

  constructor(
    private readonly sessionId: string,
    parentLogger?: SessionStateLogger,
  ) {
    if (parentLogger?.child) {
      this.log = parentLogger.child({
        scope: 'SessionStateMachine',
        sessionId,
      });
    } else {
      this.log = parentLogger ?? noopLogger;
    }
  }

  /**
   * Get current state (readonly).
   */
  getState(): SessionProcessingState {
    return this.state;
  }

  /**
   * Check if session is currently processing (convenience getter).
   * Backwards compatible with `session.isProcessing` pattern.
   */
  isProcessing(): boolean {
    return this.state === 'processing';
  }

  /**
   * Check if a transition to the target state is valid.
   */
  canTransitionTo(to: SessionProcessingState): boolean {
    return VALID_TRANSITIONS[this.state].includes(to);
  }

  /**
   * Check if we can start processing (guard for pipeline.prepareSession).
   */
  canStartProcessing(): boolean {
    return this.state === 'idle';
  }

  /**
   * Transition to a new state with validation and logging.
   * 
   * @returns true if transition succeeded, false if invalid
   */
  transition(to: SessionProcessingState, context: TransitionContext): boolean {
    const from = this.state;

    if (!this.canTransitionTo(to)) {
      this.log.warn({
        from,
        to,
        reason: context.reason,
        caller: context.caller,
        transitionCount: this.transitionCount,
      }, '[StateMachine] Invalid transition rejected');
      return false;
    }

    const now = Date.now();
    const durationMs = now - this.lastTransitionTime;
    this.state = to;
    this.lastTransitionTime = now;
    this.transitionCount++;

    this.log.debug({
      from,
      to,
      reason: context.reason,
      turnNumber: context.turnNumber,
      caller: context.caller,
      durationMs,
      transitionCount: this.transitionCount,
    }, '[StateMachine] State transition');

    return true;
  }

  // ========================================================================
  // Convenience methods for common transitions
  // These provide semantic API and enforce correct state names
  // ========================================================================

  /**
   * Start processing a turn.
   * Valid from: idle
   */
  startProcessing(reason: string, turnNumber?: number, caller?: string): boolean {
    return this.transition('processing', { reason, turnNumber, caller });
  }

  /**
   * Stop processing and return to idle.
   * Valid from: processing or awaiting_user
   */
  stopProcessing(reason: string, turnNumber?: number, caller?: string): boolean {
    return this.transition('idle', { reason, turnNumber, caller });
  }

  /**
   * Pause processing to await an approval-style interaction.
   * Valid from: processing
   */
  awaitUser(reason: string, turnNumber?: number, caller?: string): boolean {
    return this.transition('awaiting_user', { reason, turnNumber, caller });
  }

  // ========================================================================
  // Serialization for persistence
  // ========================================================================

  /**
   * Serialize state for persistence.
   */
  toJSON(): { state: SessionProcessingState; transitionCount: number } {
    return {
      state: this.state,
      transitionCount: this.transitionCount,
    };
  }

  /**
   * Restore state from persisted data.
   */
  static fromJSON(
    sessionId: string,
    data: { state: SessionProcessingState; transitionCount?: number },
    parentLogger?: SessionStateLogger,
  ): SessionStateMachine {
    const sm = new SessionStateMachine(sessionId, parentLogger);
    sm.state = data.state;
    sm.transitionCount = data.transitionCount ?? 0;
    return sm;
  }
}

/**
 * Factory function for creating state machine instances.
 * Use this instead of direct constructor for future extensibility.
 */
export function createSessionStateMachine(
  sessionId: string,
  parentLogger?: SessionStateLogger,
): SessionStateMachine {
  return new SessionStateMachine(sessionId, parentLogger);
}
