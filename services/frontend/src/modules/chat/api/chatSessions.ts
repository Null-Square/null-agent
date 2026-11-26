import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AssistantChatSessionMeta } from '@/types/chat';
import { authenticatedFetch } from '@shared/api';
import { parseApiError } from '@shared/lib/apiError';
import { validateAssistantSessions } from '@shared/lib/validators';

export type CreateScopedChatSessionPayload = {
  scopeId: string;
  modelId?: string;
  modelCategory?: string;
  initialPrompt?: string;
};

export type CreateScopedChatSessionResponse = {
  sessionId: string;
  mode: 'interactive';
  assistant: {
    mode: 'read_only';
    profileKey: string;
    scopeContext: {
      organizationId: string;
      scopeId: string;
      schema: string;
      sections: string[];
    };
  };
};

export type UpdateAssistantChatSessionPayload = {
  sessionId: string;
  title: string;
};

type CreateScopedChatSessionMutationOptions = {
  syncSessionList?: boolean;
};

type AssistantChatSessionsQueryOptions = {
  enabled?: boolean;
  limit?: number;
};

export const assistantChatSessionsQueryKey = (scopeId?: string | null, limit?: number) =>
  ['assistant-chat-sessions', scopeId ?? 'all', limit ?? 'default'] as const;

export const useAssistantChatSessionsQuery = (
  scopeId: string | null | undefined,
  options?: AssistantChatSessionsQueryOptions,
) => {
  return useQuery<AssistantChatSessionMeta[]>({
    queryKey: assistantChatSessionsQueryKey(scopeId, options?.limit),
    enabled: (options?.enabled ?? true) && Boolean(scopeId),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (scopeId) {
        params.set('scopeId', scopeId);
      }
      if (options?.limit) {
        params.set('limit', String(options.limit));
      }
      const suffix = params.toString();
      const data = await authenticatedFetch<{ sessions?: unknown }>(
        suffix ? `/api/app/chat/sessions?${suffix}` : '/api/app/chat/sessions',
      ).catch((error) => {
        throw parseApiError(error);
      });
      return validateAssistantSessions(data?.sessions ?? []);
    },
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
};

export const useCreateScopedChatSessionMutation = (
  options?: CreateScopedChatSessionMutationOptions,
) => {
  const queryClient = useQueryClient();
  const syncSessionList = options?.syncSessionList ?? true;

  return useMutation({
    retry: false,
    mutationFn: async (payload: CreateScopedChatSessionPayload) =>
      authenticatedFetch<CreateScopedChatSessionResponse>('/api/app/chat/sessions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['assistant-chat-sessions'] });
      if (syncSessionList) {
        queryClient.invalidateQueries({ queryKey: ['ai-agent-sessions'] });
      }
      if (data?.sessionId) {
        queryClient.invalidateQueries({ queryKey: ['ai-agent-session', data.sessionId] });
      }
    },
  });
};

export const useRenameAssistantChatSessionMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, title }: UpdateAssistantChatSessionPayload) =>
      authenticatedFetch<{ success: boolean; title: string }>(
        `/api/app/chat/sessions/${encodeURIComponent(sessionId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ title }),
        },
      ),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['assistant-chat-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['ai-agent-session', variables.sessionId] });
    },
  });
};

export const useDeleteAssistantChatSessionMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) =>
      authenticatedFetch<{ success: boolean }>(`/api/app/chat/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: ['assistant-chat-sessions'] });
      queryClient.removeQueries({ queryKey: ['ai-agent-session', sessionId] });
    },
  });
};
