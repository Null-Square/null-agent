/**
 * Derive Session State
 *
 * Single source of truth for session display-state derivation.
 * Backend APIs and SSE events should emit this already-derived view model.
 * The frontend should render it directly instead of rebuilding it
 * from raw blocked reasons.
 */

import type {
  DerivedSessionState,
  DeriveStatusInput,
  SessionStatus,
} from './types.js';

export function deriveSessionState(input: DeriveStatusInput = {}): DerivedSessionState {
  const blockedReason = input.blockedReason ?? null;
  const isProcessing = input.isProcessing;
  const pendingApproval = input.pendingApproval;
  const completed = input.completed;

  if (blockedReason) {
    if (blockedReason.startsWith('error_retry:') || blockedReason.startsWith('guard_retry:')) {
      return {
        status: 'running',
        pauseReason: null,
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'credits_exhausted') {
      return {
        status: 'paused',
        pauseReason: 'credits',
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'awaiting_approval') {
      return {
        status: 'paused',
        pauseReason: 'approval',
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'error') {
      return {
        status: 'error',
        pauseReason: null,
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'runner_unavailable') {
      return {
        status: 'paused',
        pauseReason: 'runner',
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'system_paused') {
      return {
        status: 'paused',
        pauseReason: 'system',
        interactionType: 'none',
        blockedReason,
      };
    }

    if (blockedReason === 'user_paused' || blockedReason === 'aborted_by_user') {
      return {
        status: 'paused',
        pauseReason: 'manual',
        interactionType: 'none',
        blockedReason,
      };
    }

    return {
      status: 'paused',
      pauseReason: 'manual',
      interactionType: 'none',
      blockedReason,
    };
  }

  if (pendingApproval) {
    return {
      status: 'paused',
      pauseReason: 'approval',
      interactionType: 'none',
      blockedReason: null,
    };
  }

  if (isProcessing === true) {
    return {
      status: 'running',
      pauseReason: null,
      interactionType: 'none',
      blockedReason: null,
    };
  }

  if (completed === true) {
    return {
      status: 'completed',
      pauseReason: null,
      interactionType: 'none',
      blockedReason: null,
    };
  }

  return {
    status: 'idle',
    pauseReason: null,
    interactionType: 'none',
    blockedReason: null,
  };
}

export function deriveStatus(input: DeriveStatusInput = {}): SessionStatus {
  return deriveSessionState(input).status;
}
