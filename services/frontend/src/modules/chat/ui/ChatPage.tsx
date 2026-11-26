import ChatRoute from './ChatRoute';
import { ChatErrorBoundary } from './ChatErrorBoundary';
import type { ReactNode } from 'react';

interface ChatPageProps {
  sessionId?: string;
  runStatus?: string | null;
  workbenchHeaderSlot?: ReactNode;
  readOnlySession?: boolean;
  syncSessionList?: boolean;
}

const ChatPage = ({
  sessionId,
  runStatus,
  workbenchHeaderSlot,
  readOnlySession,
  syncSessionList,
}: ChatPageProps) => (
  <ChatErrorBoundary>
    <ChatRoute
      sessionId={sessionId}
      runStatus={runStatus}
      workbenchHeaderSlot={workbenchHeaderSlot}
      readOnlySession={readOnlySession}
      syncSessionList={syncSessionList}
    />
  </ChatErrorBoundary>
);

export default ChatPage;
