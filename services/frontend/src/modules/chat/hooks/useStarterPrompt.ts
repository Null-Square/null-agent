import { useEffect, useRef } from 'react';
import type { Dispatch } from '@modules/chat/store/store';
import { taskActions } from '@modules/chat/store/actions';

interface UseStarterPromptParams {
  currentSessionId: string;
  starterPrompt?: string;
  messages: Array<{ role: string; content: string }>;
  sendPrompt: (prompt: string) => Promise<void>;
  dispatch: Dispatch;
}

export const useStarterPrompt = ({
  currentSessionId,
  starterPrompt,
  messages,
  sendPrompt,
  dispatch,
}: UseStarterPromptParams) => {
  const starterPromptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!starterPrompt || !currentSessionId) {
      starterPromptRef.current = null;
      return;
    }
    if (starterPromptRef.current === starterPrompt) {
      return;
    }
    const alreadyExists = messages.some(
      (message) => message.role === 'user' && message.content === starterPrompt
    );
    if (alreadyExists) {
      dispatch(taskActions.setStarterPrompt(undefined));
      starterPromptRef.current = null;
      return;
    }
    starterPromptRef.current = starterPrompt;
    console.debug('[useStarterPrompt] Sending starter prompt via hook', {
      sessionId: currentSessionId,
      promptLength: starterPrompt.length,
    });
    void sendPrompt(starterPrompt);
    dispatch(taskActions.setStarterPrompt(undefined));
  }, [
    currentSessionId,
    dispatch,
    messages,
    sendPrompt,
    starterPrompt,
  ]);

  return { starterPromptRef };
};
