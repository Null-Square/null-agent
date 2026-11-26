import type { SessionState } from '../../../domain/types';
import type { ToolContext } from './ToolContext';

export type SessionScopedToolContext = Pick<ToolContext, 'sessionId' | 'sessionStore'>;

/**
 * Narrow selector for session-bound tool operations.
 * Keeps tool code coupled to only the fields it needs.
 */
export const getSessionFromContext = (
  ctx: SessionScopedToolContext,
): SessionState | undefined => {
  return ctx.sessionStore.get(ctx.sessionId);
};

