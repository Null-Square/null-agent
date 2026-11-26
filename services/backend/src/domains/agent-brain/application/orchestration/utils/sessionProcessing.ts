/**
 * Session Processing State Utilities
 * 
 * Helper functions for session state transitions using SessionStateMachine
 * as the single source of truth.
 * 
 * NOTE: These utilities call stateMachine methods directly.
 * The isProcessing field on SessionState is deprecated - read from stateMachine instead.
 */

import type { SessionState } from '../../../domain/types';

type TransitionArgs = {
  reason: string;
  turnNumber?: number;
  caller?: string;
};

/**
 * Start processing a session (idle -> processing)
 */
export const startProcessing = (session: SessionState, args: TransitionArgs): void => {
  if (session.stateMachine) {
    session.stateMachine.startProcessing(args.reason, args.turnNumber, args.caller);
  }
};

/**
 * Stop processing and return to idle (processing -> idle)
 */
export const stopProcessing = (session: SessionState, args: TransitionArgs): void => {
  if (session.stateMachine) {
    session.stateMachine.stopProcessing(args.reason, args.turnNumber, args.caller);
  }
};

/**
 * Transition to awaiting user input (processing -> awaiting_user)
 */
export const awaitUser = (session: SessionState, args: TransitionArgs): void => {
  if (session.stateMachine) {
    session.stateMachine.awaitUser(args.reason, args.turnNumber, args.caller);
  }
};

/**
 * Check if session is currently processing
 */
export const isProcessing = (session: SessionState): boolean => {
  return session.stateMachine?.isProcessing() ?? false;
};
