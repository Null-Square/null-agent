import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { SessionUsage } from "@/types/chat";
import { AIChat } from "@modules/chat";
import AIChatProvider, { useAIChatContext } from "@modules/chat/model/AIChatContext";
import ErrorBoundary from "@shared/ui/ErrorBoundary";
import { useSessionDetailsQuery } from "@modules/sessions";
import { LoadingScreen } from '@null-ai/design-tokens/ui';

const ChatPageContent = ({
  newChat,
  sessionId,
  clearMessages,
}: {
  newChat: boolean;
  sessionId: string;
  clearMessages: () => Promise<string>;
}) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const paramsString = useMemo(() => searchParams.toString(), [searchParams]);
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  const { data: sessionDetails } = useSessionDetailsQuery(
    sessionId || '',
  );
  useEffect(() => {
    setSessionUsage(sessionDetails?.usage ?? null);
  }, [sessionDetails]);

  useEffect(() => {
    if (!newChat) return;
    setShowLoadingOverlay(true);
    clearMessages().then((newSessionId) => {
      const resolvedId = newSessionId || undefined;
      const nextParams = new URLSearchParams(paramsString);
      nextParams.delete("new");
      if (resolvedId) {
        nextParams.set("session", resolvedId);
      } else {
        nextParams.delete("session");
      }
      setSearchParams(nextParams, { replace: true });
      setShowLoadingOverlay(false);
    });
  }, [newChat, clearMessages, paramsString, setSearchParams]);

  useEffect(() => {
    if (!sessionId) return;
    const current = searchParams.get("session");
    if (current === sessionId && !searchParams.has("new")) return;
    const nextParams = new URLSearchParams(paramsString);
    nextParams.set("session", sessionId);
    nextParams.delete("new");
    setSearchParams(nextParams, { replace: true });
  }, [sessionId, paramsString, searchParams, setSearchParams]);

  return (
    <div className="relative">
      {showLoadingOverlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/85">
          <LoadingScreen variant="inline" className="min-h-0 bg-transparent" />
        </div>
      )}
      <AIChat
        config={{
          title: "NULL AI.",
          subtitle: "Your AI Security Assistant. Analyze, detect, and protect your digital assets",
          usage: {
            // FIXED: Use lastTurnInputTokens (actual prompt size) instead of totalTokens (cumulative)
            tokensUsed: sessionUsage?.lastTurnInputTokens ?? 0,
            contextWindow: sessionUsage?.contextWindow ?? undefined,
            contextRemaining:
              sessionUsage?.contextWindow && typeof sessionUsage.lastTurnInputTokens === 'number'
                ? Math.max(sessionUsage.contextWindow - sessionUsage.lastTurnInputTokens, 0)
                : undefined,
          },
        }}
      />
    </div>
  );
};

// boot screen
const ChatPageGate = ({ newChat }: { newChat: boolean }) => {
  const chatContext = useAIChatContext();
  if (!chatContext) {
    /* Signal yellow as body text, and a fourth phrasing of "wait". One screen. */
    return <LoadingScreen />;
  }
  return (
    <ChatPageContent
      newChat={newChat}
      sessionId={chatContext.sessionId}
      clearMessages={chatContext.actions.clearMessages}
    />
  );
};

export default function ChatRoute({
  sessionId: sessionIdOverride,
  runStatus,
  workbenchHeaderSlot,
  readOnlySession = false,
  syncSessionList = true,
}: {
  sessionId?: string;
  runStatus?: string | null;
  workbenchHeaderSlot?: ReactNode;
  readOnlySession?: boolean;
  syncSessionList?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const newChat = searchParams.get("new") === "1";
  // Only use sessionId if it's explicitly provided in the URL
  const sessionIdFromUrl = searchParams.get("session") ?? undefined;
  const hasSessionInUrl = searchParams.has("session");

  // If there's no session in the URL, we should not pass a sessionId to the provider
  // This ensures that we always start fresh when navigating to /chat without parameters
  const sessionId = sessionIdOverride ?? (hasSessionInUrl ? sessionIdFromUrl : undefined);
  const providerKey = workbenchHeaderSlot ? `workbench-chat-${sessionId ?? 'new'}` : 'chat-root';
  return (
    <ErrorBoundary>
      <AIChatProvider
        key={providerKey}
        sessionId={sessionId}
        runStatus={runStatus}
        workbenchHeaderSlot={workbenchHeaderSlot}
        readOnlySession={readOnlySession}
        syncSessionList={syncSessionList}
      >
        <ChatPageGate newChat={newChat} />
      </AIChatProvider>
    </ErrorBoundary>
  );
}
