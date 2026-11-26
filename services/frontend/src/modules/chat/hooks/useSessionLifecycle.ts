import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { AIChatMessageInput, ChatSessionMeta } from '@/types/chat';
import { messageActions, sessionActions } from '@modules/chat/store/actions';
import { resetFeatureState } from '@modules/chat/store/actions/root';
import type { Dispatch } from '@modules/chat/store/store';
import { useQueryClient } from '@tanstack/react-query';
import { authenticatedFetch } from '@shared/api';
import { parseApiError, toApiError, getErrorMessage, ERROR_CODES } from '@shared/lib/apiError';
import {
  resolveSessionPresentation,
  type DesiredSessionExecution,
  type SessionExecutionCondition,
} from '@null-ai/contracts';
export interface SessionLifecycleParams {
  currentSessionId: string;
  setCurrentSessionId: (id: string) => void;
  setSessionMode: (mode: 'interactive' | 'automated' | null) => void;
  dispatch: Dispatch;
  connectStream: (sessionId: string) => void;
  disconnectStream: () => void;
  isLoading: boolean;
  sessionMode?: 'interactive' | 'automated' | null;
  runStatus?: string | null;
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  isAborting: boolean;
  blockedReason?: string | null;
  addMessage: (message: AIChatMessageInput) => string;
  pendingUserMessagesRef: MutableRefObject<Array<{ tempId: string; content: string }>>;
  assistantMessageRef: MutableRefObject<string | null>;
  flushCoalescedUpdates: () => void;
  resetCoalescers: () => void;
  pushToast: (message: string) => void;
  clearToast: () => void;
  generateId: () => string;
  syncSessionList?: boolean;
}

type ExecutionMutationResponse = {
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  conditionReason?: string | null;
  status?: 'idle' | 'paused' | 'running' | 'failed' | 'completed' | 'error';
  pause_reason?: 'manual' | 'approval' | 'credits' | 'runner' | 'system' | null;
  interaction_type?: 'none';
  blocked_reason?: string | null;
  message?: string;
};

export const useSessionLifecycle = ({
  currentSessionId,
  setCurrentSessionId,
  setSessionMode,
  dispatch,
  connectStream,
  disconnectStream,
  isLoading,
  sessionMode = null,
  runStatus,
  desiredExecution,
  condition,
  isAborting,
  blockedReason,
  addMessage,
  pendingUserMessagesRef,
  assistantMessageRef,
  flushCoalescedUpdates,
  resetCoalescers,
  pushToast,
  clearToast,
  generateId,
  syncSessionList = true,
}: SessionLifecycleParams) => {
  const queryClient = useQueryClient();
  const swallowError = (): void => {};
  const applyCommittedExecution = useCallback((
    sessionId: string,
    response: ExecutionMutationResponse,
  ): boolean => {
    const hasCanonicalPair = Boolean(response?.desiredExecution && response.condition);
    if (hasCanonicalPair) {
      const presentation = resolveSessionPresentation(response);
      dispatch(sessionActions.setSessionStatus(presentation.status));
      dispatch(
        sessionActions.setPauseMeta(
          presentation.pauseReason,
          'none',
          response.blocked_reason ?? null,
        ),
      );
      queryClient.setQueryData<ChatSessionMeta | undefined>(
        ['ai-agent-session', sessionId],
        (old) => old
          ? {
              ...old,
              desiredExecution: response.desiredExecution,
              condition: response.condition,
              conditionReason: response.conditionReason ?? null,
              status: presentation.status,
              blocked_reason: response.blocked_reason ?? null,
              pause_reason: presentation.pauseReason,
              interaction_type: 'none',
            }
          : old,
      );
      if (syncSessionList) {
        queryClient.setQueryData<ChatSessionMeta[]>(
          ['ai-agent-sessions'],
          (old) => old?.map((entry) => entry.id === sessionId
            ? {
                ...entry,
                desiredExecution: response.desiredExecution,
                condition: response.condition,
                conditionReason: response.conditionReason ?? null,
                status: presentation.status,
                blocked_reason: response.blocked_reason ?? null,
                pause_reason: presentation.pauseReason,
                interaction_type: 'none',
              }
            : entry) ?? [],
        );
      }
    }

    queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionId] }).catch(swallowError);
    if (syncSessionList) {
      queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
    }
    queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(swallowError);
    queryClient.invalidateQueries({ queryKey: ['run'] }).catch(swallowError);
    return hasCanonicalPair;
  }, [dispatch, queryClient, syncSessionList]);
  const extractGateError = useCallback((error: unknown): string | null => {
    const apiError = parseApiError(error);
    const response = apiError.response;
    const code = apiError.code;
    const message = apiError.message;

    switch (code) {
      case ERROR_CODES.GATING_FEATURE_NOT_AVAILABLE:
        return message ?? 'This feature is not available.';
      case ERROR_CODES.RESOURCE_LIMIT_REACHED:
        return message ?? 'You have reached your concurrent session limit. Close a session first.';
      default:
        break;
    }
    
    // Check response code for additional patterns
    const responseCode = response?.code as string | undefined;
    if (responseCode === ERROR_CODES.GATING_TASK_RESTRICTED || responseCode === 'task.restricted') {
      return message ?? 'This task is locked.';
    }
    if (responseCode === ERROR_CODES.GATING_SCHEDULES_EXCEEDED || responseCode === 'limit.schedules_exceeded') {
      return message ?? 'Schedule limit reached.';
    }
    
    // Status-based fallbacks
    if (apiError.status === 403) {
      return message ?? 'This action is not allowed.';
    }
    if (apiError.status === 429 && message) {
      return message;
    }
    return null;
  }, []);
  const resetSessionState = useCallback(async () => {
    flushCoalescedUpdates();
    resetCoalescers();
    dispatch(resetFeatureState());
    setSessionMode(null);
    pendingUserMessagesRef.current = [];
    assistantMessageRef.current = null;
    disconnectStream();
    clearToast();

    if (currentSessionId) {
      try {
        await authenticatedFetch(`/api/ai-agent/sessions/${currentSessionId}`, { method: 'DELETE' });
      } catch (cleanupError) {
        console.warn('[useSessionLifecycle] Session cleanup failed:', cleanupError);
      }
    }

    setCurrentSessionId('');
  }, [
    assistantMessageRef,
    clearToast,
    currentSessionId,
    disconnectStream,
    dispatch,
    flushCoalescedUpdates,
    pendingUserMessagesRef,
    resetCoalescers,
    setSessionMode,
    setCurrentSessionId,
  ]);

  const sendPrompt = useCallback(
    async (prompt: string): Promise<void> => {
      const trimmed = prompt.trim();
      if (!trimmed) {
        return;
      }

      const isRunWorkbenchSession = sessionMode === 'automated' && typeof runStatus !== 'undefined';
      const executionBlocksInput = desiredExecution === 'running' && (
        condition === 'executing'
        || condition === 'recovering'
        || condition === 'waiting_credits'
        || condition === 'waiting_runner'
        || (condition === 'waiting_prerequisite' && blockedReason !== 'awaiting_user')
      );
      const awaitingStructuredResponse = condition === 'waiting_approval';
      if (isRunWorkbenchSession && (executionBlocksInput || awaitingStructuredResponse || isLoading)) {
        pushToast(
          awaitingStructuredResponse
            ? 'Use the response form before sending a workbench message.'
            : 'Stop the run before sending a workbench message.',
        );
        return;
      }

      // A chat session is created by its scope (or by a run) before the composer can send.
      const sessionIdToUse = currentSessionId;
      if (!sessionIdToUse) {
        pushToast('Start a chat from a scope first.');
        return;
      }

      connectStream(sessionIdToUse);

      const tempId = addMessage({
        id: generateId(),
        role: 'user',
        content: trimmed,
        timestamp: new Date(),
        status: 'sending',
      });

      pendingUserMessagesRef.current = [
        ...pendingUserMessagesRef.current,
        { tempId, content: trimmed },
      ];

      dispatch(sessionActions.setLoading(true));
      
      try {
        const response = await authenticatedFetch<ExecutionMutationResponse>(`/api/ai-agent/sessions/${sessionIdToUse}/message`, {
          method: 'POST',
          body: JSON.stringify({ text: trimmed }),
        });
        applyCommittedExecution(sessionIdToUse, response);

        dispatch(messageActions.updateMessageStatus(tempId, 'sent'));
        pendingUserMessagesRef.current = pendingUserMessagesRef.current.filter(
          (pendingMessage) => pendingMessage.tempId !== tempId,
        );
        // Refresh the session and session list after successful message
        queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionIdToUse] }).catch(swallowError);
        if (syncSessionList) {
          queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
        }
        queryClient.invalidateQueries({ queryKey: ['runs'] }).catch(swallowError);
        queryClient.invalidateQueries({ queryKey: ['run'] }).catch(swallowError);
      } catch (error: unknown) {
        // Use parseApiError for typed access
        const apiError = toApiError(error);
        const gateMessage = extractGateError(error) ?? apiError.message;
        const message = gateMessage ??  'Failed to send prompt. Please try again.';
        dispatch(messageActions.updateMessageStatus(tempId, 'error'));
        dispatch(sessionActions.setLoading(false));
        queryClient.invalidateQueries({ queryKey: ['ai-agent-session', sessionIdToUse] }).catch(swallowError);
        if (syncSessionList) {
          queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] }).catch(swallowError);
        }
        pushToast(message);
      }
    },
    [
      addMessage,
      applyCommittedExecution,
      blockedReason,
      connectStream,
      condition,
      desiredExecution,
      currentSessionId,
      dispatch,
      isLoading,
      pendingUserMessagesRef,
      pushToast,
      queryClient,
      runStatus,
      sessionMode,
      syncSessionList,
      extractGateError,
      generateId,
    ],
  );

  const abortTurn = useCallback(async (): Promise<void> => {
    if (!currentSessionId) {
      pushToast('No active session to stop.');
      return;
    }

    if (isAborting) {
      return;
    }

    const canStopCanonicalExecution = desiredExecution === 'running'
      && condition !== 'idle'
      && condition !== 'completed';
    if (!canStopCanonicalExecution && !isLoading) {
      pushToast('Agent is idle.');
      return;
    }

    try {
      dispatch(sessionActions.setAborting(true));
      const response = await authenticatedFetch<ExecutionMutationResponse>(
        `/api/ai-agent/sessions/${currentSessionId}/stop`,
        { method: 'POST' },
      );

      dispatch(sessionActions.setAborting(false));
      dispatch(sessionActions.setLoading(false));
      applyCommittedExecution(currentSessionId, response);
      if (response.message && (response.status !== 'paused' || response.pause_reason !== 'manual')) {
        pushToast(response.message);
      }
    } catch (error: unknown) {
      dispatch(sessionActions.setAborting(false));
      const apiError = toApiError(error);
      const message = getErrorMessage(error) || 'Failed to stop the current turn';
      console.error('Stop turn failed:', apiError.message);
      pushToast(message);
    }
  }, [applyCommittedExecution, condition, currentSessionId, desiredExecution, dispatch, isAborting, isLoading, pushToast]);

  const clearMessages = useCallback(async (): Promise<string> => {
    await resetSessionState();
    return '';
  }, [resetSessionState]);

  return {
    sendPrompt,
    abortTurn,
    clearMessages,
  };
};
