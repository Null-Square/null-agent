import React, { useMemo } from 'react';
import { AIChatConfig } from '@/types/chat';
import { useAIChat } from '@modules/chat/model/AIChatContext';
import { FileCode } from 'lucide-react';
import { ChatStreamTerminal, CollapsiblePlanPanel } from '@modules/chat';
import { AgentTerminal } from '@modules/chat';
import { AgentWorkbenchShell, EmptyState } from '@null-ai/design-tokens/ui';
import { resolveSessionPresentation, type SessionDisplayKind } from '@null-ai/contracts';
import { ExecutionTargetIndicator } from '@shared/ui/ExecutionTargetIndicator';
import { SessionActionButtons, useSessionActions } from '@modules/sessions';

interface ConversationViewProps {
  config?: AIChatConfig;
}

const workbenchToneFor = (
  kind: SessionDisplayKind,
): 'active' | 'paused' | 'error' | 'idle' => {
  switch (kind) {
    case 'running':
    case 'recovering':
    case 'waiting_approval':
      return 'active';
    case 'stopped':
    case 'waiting_credits':
    case 'waiting_runner':
    case 'waiting_prerequisite':
      return 'paused';
    default:
      return 'idle';
  }
};

const ConversationViewNullSquare: React.FC<ConversationViewProps> = ({ config }) => {
  const {
    messages,
    sessionId,
    sessionStatus,
    desiredExecution,
    condition,
    conditionReason,
    pauseReason,
    interactionType,
    blockedReason,
    isAborting,
    toolStreams,
    sandboxPolicy,
    sessionMode,
    runStatus,
    executionTarget,
    runnerName,
    plan,
    readOnlySession,
    workbenchHeaderSlot,
  } = useAIChat();
  const {
    stopSession,
    startSession,
    isStopping,
    isStarting,
  } = useSessionActions();

  const promptCount = messages.filter((m) => m.role === 'user').length;
  const activeTaskTitle = (config?.title ?? 'NULL AI').toUpperCase();
  const sessionModeLabel = sessionMode === 'automated' ? 'AUTOMATED' : 'INTERACTIVE';
  const sessionPresentation = useMemo(
    () => resolveSessionPresentation({
      desiredExecution,
      condition,
      conditionReason,
      status: sessionStatus,
      pauseReason,
      interactionType,
      blockedReason,
    }),
    [blockedReason, condition, conditionReason, desiredExecution, interactionType, pauseReason, sessionStatus],
  );
  const statusIndicator = useMemo(() => {
    if (isAborting || isStopping) {
      return { tone: 'stopping' as const, label: 'STOPPING' };
    }
    return {
      tone: workbenchToneFor(sessionPresentation.kind),
      label: sessionPresentation.label,
    };
  }, [isAborting, isStopping, sessionPresentation]);

  const handleStopSession = async () => {
    if (!sessionId) return;
    await stopSession(sessionId);
  };

  const handleStartSession = async () => {
    if (!sessionId) return;
    await startSession(sessionId);
  };

  const hasPlan = plan && plan.length > 0;
  const isTerminalRun = runStatus === 'completed' || runStatus === 'failed' || runStatus === 'cancelled';
  const opsActivityToken = Object.values(toolStreams)
    .reduce((total, stream) => total + stream.chunks.length, 0);

  return (
    <AgentWorkbenchShell
      modeLabel={sessionModeLabel}
      statusLabel={statusIndicator.label}
      statusTone={statusIndicator.tone}
      readOnly={readOnlySession}
      counterValue={promptCount}
      contextUsage={config?.usage?.contextWindow
        ? { used: config.usage.tokensUsed ?? 0, total: config.usage.contextWindow }
        : undefined}
      headerMeta={(
        <>
          {executionTarget ? (
            <ExecutionTargetIndicator
              target={executionTarget}
              runnerName={runnerName}
              size="sm"
              className="hidden md:inline-flex"
            />
          ) : null}
          {sandboxPolicy?.profile ? (
            <span className="text-[9px] font-mono uppercase tracking-[0.2em] text-muted-foreground px-2 py-0.5 border border-border">
              {sandboxPolicy.profile}
            </span>
          ) : null}
        </>
      )}
      headerActions={sessionId && !readOnlySession && !isTerminalRun ? (
        <SessionActionButtons
          desiredExecution={desiredExecution}
          condition={condition}
          conditionReason={conditionReason}
          status={sessionStatus}
          blockedReason={blockedReason}
          pauseReason={pauseReason}
          interactionType={interactionType}
          sessionId={sessionId}
          onStop={handleStopSession}
          onStart={handleStartSession}
          isStopping={isStopping}
          isStarting={isStarting}
          compact
        />
      ) : undefined}
      taskTitle={activeTaskTitle}
      sessionId={sessionId}
      phaseRail={workbenchHeaderSlot}
      opsActivityToken={opsActivityToken}
      transcript={(
        <div className="h-full overflow-hidden p-2 lg:p-4">
            <ChatStreamTerminal
              showUserMessages={readOnlySession}
              emptyStateTitle={readOnlySession ? 'Phase Transcript' : 'Live Agent Monitor'}
              emptyStateDescription={
                readOnlySession
                  ? 'No persisted chat messages were recorded for this phase.'
                : 'Waiting for the first agent message.'
              }
            />
        </div>
      )}
      opsConsole={<AgentTerminal className="h-full w-full min-w-0 flex-1" />}
      plan={hasPlan ? (
        <CollapsiblePlanPanel />
      ) : (
        <div className="p-6">
          <EmptyState
            icon={FileCode}
            title="No Execution Plan"
            description="The agent will create a plan once the task starts running."
          />
        </div>
      )}
    />
  );
};

export default ConversationViewNullSquare;


