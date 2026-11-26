import { useQuery, useMutation, useQueryClient, type Query } from '@tanstack/react-query';
import { api, apiBaseUrl, fetchApi, type paths } from '@shared/api';
import type { ChatSessionMeta, ChatSessionSnapshot } from '@/types/chat';
import { parseApiError, shouldRetry } from '@shared/lib/apiError';
import { validateSession, validateSessions } from '@shared/lib/validators';
import { logWorkbenchDebug, summarizeSessionSnapshot } from '@shared/lib/workbenchDebug';

type SessionsQueryOptions = {
  enabled?: boolean;
};

export const useSessionsQuery = (options?: SessionsQueryOptions) =>
  useQuery<ChatSessionMeta[]>({
    queryKey: ['ai-agent-sessions'],
    enabled: options?.enabled ?? true,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/ai-agent/sessions');
      if (error) throw parseApiError(error);
      if (!Array.isArray(data?.sessions)) return [];
      return validateSessions(data.sessions);
    },
    staleTime: 3_000, // Consider data stale after 3 seconds
    refetchInterval: 30_000, // Poll every 30 seconds (fallback - SSE provides real-time updates)
    refetchIntervalInBackground: false, // Don't poll when tab is hidden
    refetchOnWindowFocus: true, // Refetch when user returns to tab
    retry: (failureCount, error) => {
      if (!shouldRetry(error)) return false;
      return failureCount < 2;
    },
  });

type RefetchInterval<T> = number | false | ((query: Query<T>) => number | false | undefined);
type SessionQueryOptions<T> = {
  enabled?: boolean;
  refetchInterval?: RefetchInterval<T>;
  staleTime?: number;
  refetchOnMount?: boolean | 'always';
};

type SessionTopologySnapshot = Pick<
  ChatSessionSnapshot,
  | 'id'
  | 'title'
  | 'status'
  | 'pause_reason'
  | 'interaction_type'
  | 'blocked_reason'
  | 'blocked_meta'
  | 'completed'
  | 'executionTarget'
  | 'runnerId'
  | 'runnerName'
  | 'coordination'
  | 'workerTasks'
  | 'workerResult'
>;

export const useSessionDetailsQuery = (
  sessionId: string | undefined,
  options?: SessionQueryOptions<ChatSessionSnapshot>,
) =>
{
  return useQuery<ChatSessionSnapshot>({
    queryKey: ['ai-agent-session', sessionId],
    enabled: options?.enabled ?? !!sessionId,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/ai-agent/sessions/{sessionId}', {
        params: { path: { sessionId: sessionId! } },
      });
      if (error) throw parseApiError(error);
      if (!data?.session) throw new Error('Session not found');
      const session = validateSession(data.session);
      logWorkbenchDebug('session.details.fetched', summarizeSessionSnapshot(session));
      return session;
    },
    staleTime: options?.staleTime ?? 5000, // Reduced from 30s to 5s for better responsiveness
    refetchOnMount: options?.refetchOnMount,
    refetchOnWindowFocus: true,
    refetchInterval: options?.refetchInterval,
    retry: (failureCount, error) => {
      // Don't retry on rate limit or client errors
      if (!shouldRetry(error)) return false;
      return failureCount < 2;
    },
  });
};

export const useSessionTopologyQuery = (
  sessionId: string | undefined,
  options?: SessionQueryOptions<SessionTopologySnapshot>,
) => {
  return useQuery<SessionTopologySnapshot>({
    queryKey: ['ai-agent-session-topology', sessionId],
    enabled: !!sessionId,
    queryFn: async () => {
      const response = await fetchApi.get<{ session?: unknown }>(
        `/ai-agent/sessions/${sessionId}/topology`,
      );
      if (!response.data?.session) {
        throw new Error('Session topology not found');
      }
      return validateSession(response.data.session) as SessionTopologySnapshot;
    },
    staleTime: options?.staleTime ?? 2_000,
    refetchOnMount: options?.refetchOnMount,
    refetchOnWindowFocus: true,
    refetchInterval: options?.refetchInterval,
    retry: (failureCount, error) => {
      if (!shouldRetry(error)) return false;
      return failureCount < 2;
    },
  });
};

type SessionMessageWire =
  paths['/api/ai-agent/sessions/{sessionId}/messages']['get']['responses'][200]['content']['application/json']['messages'][number];

type SessionMessageRaw = Omit<SessionMessageWire, 'createdAt' | 'timestamp'> & {
  createdAt: number | string;
  timestamp: number | string;
};

export const fetchSessionMessages = async (
  sessionId: string,
  opts?: { limit?: number; cursor?: string; direction?: 'forward' | 'backward' },
): Promise<{ messages: SessionMessageRaw[]; pagination?: unknown }> => {
  const { data, error } = await api.GET('/api/ai-agent/sessions/{sessionId}/messages', {
    params: {
      path: { sessionId },
      query: {
        limit: opts?.limit?.toString(),
        offset: opts?.cursor,
      },
    },
  });
  if (error) throw parseApiError(error);
  const messages: SessionMessageRaw[] = (data?.messages ?? []).map((m) => {
    const ts = m.createdAt ?? m.timestamp ?? Date.now();
    return {
      ...m,
      createdAt: ts,
      timestamp: ts,
    };
  });
  return {
    messages,
    pagination: undefined, // OpenAPI doesn't expose this yet
  };
};

export const useDeleteSessionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const { error } = await api.DELETE('/api/ai-agent/sessions/{sessionId}', {
        params: { path: { sessionId } },
      });
      if (error) throw parseApiError(error);
      return sessionId;
    },
    onMutate: async (sessionId) => {
      // Cancel outgoing queries
      await queryClient.cancelQueries({ queryKey: ['ai-agent-sessions'] });

      // Snapshot previous state for rollback
      const previousSessions = queryClient.getQueryData<ChatSessionMeta[]>(['ai-agent-sessions']);

      // Optimistically remove session from list
      if (previousSessions) {
        queryClient.setQueryData<ChatSessionMeta[]>(
          ['ai-agent-sessions'],
          previousSessions.filter((s) => s.id !== sessionId)
        );
      }

      return { previousSessions };
    },
    onError: (_error, _sessionId, context) => {
      // Rollback on error
      if (context?.previousSessions) {
        queryClient.setQueryData(['ai-agent-sessions'], context.previousSessions);
      }
    },
    onSettled: (sessionId) => {
      // Reconcile with server state
      queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
      if (sessionId) {
        queryClient.removeQueries({ queryKey: ['ai-agent-session', sessionId] });
      }
      queryClient.invalidateQueries({ queryKey: ['subscription'] });
    },
  });
};

export const useRenameSessionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      const res = await fetch(`${apiBaseUrl}/api/ai-agent/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
        credentials: 'include',
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({ message: 'Failed to rename session' }));
        throw new Error(error.message || 'Failed to rename session');
      }
      return { sessionId, title };
    },
    onMutate: async ({ sessionId, title }) => {
      // Cancel outgoing queries
      await queryClient.cancelQueries({ queryKey: ['ai-agent-sessions'] });

      // Snapshot previous state for rollback
      const previousSessions = queryClient.getQueryData<ChatSessionMeta[]>(['ai-agent-sessions']);

      // Optimistically update session title in list
      if (previousSessions) {
        queryClient.setQueryData<ChatSessionMeta[]>(
          ['ai-agent-sessions'],
          previousSessions.map((s) => (s.id === sessionId ? { ...s, title } : s))
        );
      }

      return { previousSessions };
    },
    onError: (_error, _vars, context) => {
      // Rollback on error
      if (context?.previousSessions) {
        queryClient.setQueryData(['ai-agent-sessions'], context.previousSessions);
      }
    },
    onSettled: (data) => {
      // Reconcile with server state
      queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
      if (data?.sessionId) {
        queryClient.invalidateQueries({ queryKey: ['ai-agent-session', data.sessionId] });
      }
    },
  });
};

