import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AIChatMessage, TaskSummary } from '@/types/chat';
import {
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
} from '@modules/sessions/lib/sessionTitle';

interface UseDerivedSessionTitleParams {
  sessionId: string;
  messages: AIChatMessage[];
  task?: TaskSummary;
  enabled?: boolean;
}

/**
 * Gives a still-unnamed session a title in the sessions list.
 *
 * A session is created before anyone has said anything, so the server names it
 * "New chat" and the sidebar shows a column of identical rows. The first user
 * message (or the task, when there is one) is what tells them apart, so it is
 * derived here and written into the list the sidebar already reads.
 *
 * This is a cache patch and nothing more. It was previously bundled with a
 * localStorage copy of the whole transcript — see `legacyChatStorage` for why
 * that is gone: the messages are server-owned and hydrated from the session
 * snapshot, so the local copy had no reader and eventually no room either.
 */
export const useDerivedSessionTitle = ({
  sessionId,
  messages,
  task,
  enabled = true,
}: UseDerivedSessionTitleParams) => {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || !sessionId) {
      return;
    }
    const spoken = messages.filter((message) => message.role !== 'tool');
    if (spoken.length === 0) {
      return;
    }
    const derivedTitle = deriveSessionTitle({
      taskTitle: task?.title,
      userPrompt: spoken.find((message) => message.role === 'user')?.content,
      fallback: DEFAULT_SESSION_TITLE,
    });

    queryClient.setQueryData<{ id: string; title?: string | null }[]>(
      ['ai-agent-sessions'],
      (prev) => {
        if (!prev) return prev;
        return prev.map((session) =>
          session.id === sessionId &&
          (!session.title || session.title === DEFAULT_SESSION_TITLE)
            ? { ...session, title: derivedTitle }
            : session
        );
      },
    );
  }, [enabled, messages, queryClient, sessionId, task]);
};
