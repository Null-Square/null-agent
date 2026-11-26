// features/ai-chat/components/AIChat.tsx
import React, { useEffect, useRef, useState } from 'react';
import { HeroWave } from './HeroWave';
import ConversationViewNullSquare from './ConversationViewNullSquare';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { AIChatConfig } from '@/types/chat';
import { cn } from '@shared/lib/utils';


interface AIChatProps {
  config?: AIChatConfig;
}

const AIChat: React.FC<AIChatProps> = ({ config }) => {
  const { messages, config: contextConfig, sessionId, task, sessionMode, runStatus } = useAIChat();
  const mergedConfig: AIChatConfig = {
    ...contextConfig,
    ...config,
    usage: {
      ...(config?.usage ?? {}),
      ...(contextConfig?.usage ?? {}),
    },
  };

  type ViewState = 'hero' | 'transitioning' | 'conversation';
  const [view, setView] = useState<ViewState>('hero');
  const transitionTimeoutRef = useRef<number | null>(null);
  const activeTaskId = task?.id ?? '';
  const isWorkbenchAutomated = sessionMode === 'automated' && typeof runStatus !== 'undefined';
  const isAutomated = sessionMode === 'automated' && !isWorkbenchAutomated;

  useEffect(() => {
    if (isAutomated) {
      setView('hero');
      return;
    }
    const hasSession =
      messages.length > 0 || Boolean(sessionId) || Boolean(activeTaskId);
    if (hasSession && view === 'hero') {
      setView('transitioning');
    }
    if (!hasSession && view === 'conversation') {
      setView('hero');
    }
  }, [isAutomated, messages.length, sessionId, activeTaskId, view]);

  useEffect(() => {
    if (view === 'transitioning') {
      if (transitionTimeoutRef.current) {
        window.clearTimeout(transitionTimeoutRef.current);
      }
      transitionTimeoutRef.current = window.setTimeout(() => {
        setView('conversation');
        transitionTimeoutRef.current = null;
      }, 650);
    }

    return () => {
      if (transitionTimeoutRef.current) {
        window.clearTimeout(transitionTimeoutRef.current);
        transitionTimeoutRef.current = null;
      }
    };
  }, [view]);

  const shouldRenderHero = view !== 'conversation' || isAutomated;
  const shouldRenderConversation = isWorkbenchAutomated || (!isAutomated && view !== 'hero');

  return (
    <div className="relative min-h-screen overflow-hidden">
      {shouldRenderHero && (
        <div
          className={cn(
            'relative z-10 min-h-screen transition-all duration-700 ease-in-out',
            view === 'transitioning'
              ? 'pointer-events-none opacity-0 translate-y-6'
              : 'pointer-events-auto opacity-100 translate-y-0'
          )}
        >
          <HeroWave
            className={cn(
              'transition-all duration-700 ease-in-out',
              view === 'transitioning' ? 'opacity-0 scale-[0.97]' : 'opacity-100 scale-100'
            )}
            title={mergedConfig.title || 'NULL AI.'}
            subtitle={
              mergedConfig.subtitle ||
              'Your AI Security Assistant. Analyze, detect, and protect your digital assets'
            }
            placeholder={mergedConfig.placeholder || 'Analyze my'}
            buttonText={mergedConfig.buttonText || 'Analyze'}
          />
        </div>
      )}

      <div
        className={cn(
          'absolute inset-0 z-20 bg-background transition-opacity duration-700 ease-in-out',
          view === 'hero' ? 'opacity-0 pointer-events-none' : 'opacity-90'
        )}
      />

      {shouldRenderConversation && (
        <div
          className={cn(
            'absolute inset-0 z-30 transition-all duration-700 ease-out',
            view === 'transitioning'
              ? 'pointer-events-none opacity-0 translate-y-10'
              : 'pointer-events-auto opacity-100 translate-y-0'
          )}
        >
          <ConversationViewNullSquare config={mergedConfig} />
        </div>
      )}


    </div>
  );
};

export default AIChat;
