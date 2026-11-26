/** Stop/Start command hook. The server response is the only cache authority. */

import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DESIRED_SESSION_EXECUTIONS,
  SESSION_EXECUTION_CONDITIONS,
  type SessionExecutionReadModel,
} from '@null-ai/contracts';
import { apiBaseUrl } from '@shared/api';
import { toastService } from '@shared/services/toastService';
import { toApiError } from '@/shared/lib/apiError';
import type { ChatSessionMeta } from '@/types/chat';

export interface SessionActionResult {
  success: boolean;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

export interface SessionActionsHook {
  isStopping: boolean;
  isStarting: boolean;
  stopSession: (sessionId: string) => Promise<SessionActionResult>;
  startSession: (sessionId: string) => Promise<SessionActionResult>;
}

const readExecutionModel = (data: Record<string, unknown>): SessionExecutionReadModel | null => {
  const desiredExecution = data.desiredExecution;
  const condition = data.condition;
  if (
    !DESIRED_SESSION_EXECUTIONS.includes(desiredExecution as SessionExecutionReadModel['desiredExecution'])
    || !SESSION_EXECUTION_CONDITIONS.includes(condition as SessionExecutionReadModel['condition'])
  ) return null;
  return {
    desiredExecution: desiredExecution as SessionExecutionReadModel['desiredExecution'],
    condition: condition as SessionExecutionReadModel['condition'],
    conditionReason: typeof data.conditionReason === 'string' ? data.conditionReason : null,
  };
};

export const useSessionActions = (): SessionActionsHook => {
  const queryClient = useQueryClient();
  const [isStopping, setIsStopping] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const applyCommittedProjection = useCallback((
    sessionId: string,
    data: Record<string, unknown>,
  ) => {
    const execution = readExecutionModel(data);
    if (execution) {
      queryClient.setQueryData<ChatSessionMeta | undefined>(
        ['ai-agent-session', sessionId],
        (current) => current ? { ...current, ...execution } : current,
      );
      queryClient.setQueryData<ChatSessionMeta[] | undefined>(
        ['ai-agent-sessions'],
        (current) => current?.map((session) =>
          session.id === sessionId ? { ...session, ...execution } : session),
      );
    }
    void queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionId] });
    void queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
    // The backend run aggregate remains authoritative; invalidation is read-only.
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
    void queryClient.invalidateQueries({ queryKey: ['run'] });
  }, [queryClient]);

  const execute = useCallback(async (
    action: 'stop' | 'start',
    sessionId: string,
  ): Promise<SessionActionResult> => {
    if (!sessionId) return { success: false, error: 'Invalid session ID' };
    if (action === 'stop') setIsStopping(true);
    else setIsStarting(true);
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/ai-agent/sessions/${encodeURIComponent(sessionId)}/${action}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        applyCommittedProjection(sessionId, data);
        const message = typeof data.message === 'string'
          ? data.message
          : `Failed to ${action} session`;
        if (response.status !== 409 || action === 'start') toastService.error(message);
        return { success: false, error: message, data };
      }
      applyCommittedProjection(sessionId, data);
      const message = typeof data.message === 'string'
        ? data.message
        : action === 'stop' ? 'Session stopped' : 'Session started';
      toastService.success(message);
      return { success: true, data };
    } catch (error) {
      const message = toApiError(error).message || `Failed to ${action} session`;
      toastService.error(message);
      return { success: false, error: message };
    } finally {
      if (action === 'stop') setIsStopping(false);
      else setIsStarting(false);
    }
  }, [applyCommittedProjection]);

  return {
    isStopping,
    isStarting,
    stopSession: useCallback((sessionId) => execute('stop', sessionId), [execute]),
    startSession: useCallback((sessionId) => execute('start', sessionId), [execute]),
  };
};

export default useSessionActions;
