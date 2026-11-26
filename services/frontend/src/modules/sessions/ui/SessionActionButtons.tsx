/**
 * SessionActionButtons
 *
 * Renders semantic session controls from canonical backend status:
 * - running -> Stop
 * - stopped(manual) -> Start
 * - waiting(runner) -> Start after the compatible runner returns
 * - completed -> Start the preserved session history explicitly
 * - paused(system/approval) -> no generic action
 */

import React from 'react';
import {
  Square,
  Play,
  Trash2,
  Edit3,
} from 'lucide-react';
import { Button } from '@null-ai/design-tokens/ui';
import { getSessionActions } from '@modules/sessions/lib/sessionStateUtils';
import type { DesiredSessionExecution, SessionExecutionCondition } from '@null-ai/contracts';

export interface SessionActionButtonsProps {
  desiredExecution?: DesiredSessionExecution;
  condition?: SessionExecutionCondition;
  conditionReason?: string | null;
  status: string | undefined;
  blockedReason?: string | null;
  pauseReason?: 'manual' | 'approval' | 'credits' | 'runner' | 'system' | null;
  interactionType?: 'none' | null;
  sessionId: string;
  onStop?: () => void;
  onStart?: () => void;
  onDelete?: () => void;
  onRename?: () => void;
  isStopping?: boolean;
  isStarting?: boolean;
  isDeleting?: boolean;
  isRenaming?: boolean;
  compact?: boolean;
  className?: string;
}

export const SessionActionButtons: React.FC<SessionActionButtonsProps> = ({
  desiredExecution,
  condition,
  conditionReason,
  status,
  blockedReason,
  pauseReason,
  interactionType,
  sessionId,
  onStop,
  onStart,
  onDelete,
  onRename,
  isStopping = false,
  isStarting = false,
  isDeleting = false,
  isRenaming = false,
  compact = false,
  className,
}) => {
  const actions = getSessionActions({
    desiredExecution,
    condition,
    conditionReason,
    status,
    blockedReason,
    pauseReason,
    interactionType,
  });
  const buttonSize = compact ? 'sm' : 'default';
  const iconSize = compact ? 'h-3 w-3' : 'h-4 w-4';

  const hasAnyAction =
    (actions.showStop && Boolean(onStop)) ||
    (actions.showStart && Boolean(onStart)) ||
    Boolean(onDelete) ||
    Boolean(onRename);

  if (!hasAnyAction) {
    return null;
  }

  const renderActionButton = (
    content: React.ReactNode,
    buttonProps: React.ComponentProps<typeof Button> & { 'data-testid'?: string },
  ) => {
    return (
      <Button {...buttonProps}>
        {content}
      </Button>
    );
  };

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      {actions.showStop && onStop
        ? renderActionButton(
            <>
              {isStopping ? <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> : <Square className={iconSize} />}
              {!compact && <span className="ml-1.5">Stop</span>}
            </>,
            {
              variant: 'outline',
              size: buttonSize,
              onClick: onStop,
              disabled: isStopping,
              'data-testid': `session-action-${sessionId}-stop`,
              className: 'h-10 flex-1 border-warning/40 text-warning hover:bg-warning hover:text-black hover:border-warning',
              title: 'Stop execution',
            },
          )
        : null}

      {actions.showStart && onStart
        ? renderActionButton(
            <>
              {isStarting ? <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> : <Play className={iconSize} />}
              {!compact && <span className="ml-1.5">Start</span>}
            </>,
            {
              variant: 'outline',
              size: buttonSize,
              onClick: onStart,
              disabled: isStarting,
              'data-testid': `session-action-${sessionId}-start`,
              className: 'h-10 flex-1 border-success/40 text-success hover:bg-success hover:text-black hover:border-success',
              title: 'Start execution',
            },
          )
        : null}

      {onRename ? (
        <Button
          variant="outline"
          size={buttonSize}
          onClick={onRename}
          disabled={isRenaming}
          data-testid={`session-action-${sessionId}-rename`}
          className="border-ns-fg-muted/40 text-muted-foreground hover:bg-ns-fg-muted hover:text-black hover:border-ns-fg-muted"
          title="Rename session"
        >
          {isRenaming ? <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> : <Edit3 className={iconSize} />}
          {!compact && <span className="ml-1.5">Rename</span>}
        </Button>
      ) : null}

      {onDelete ? (
        <Button
          variant="outline"
          size={buttonSize}
          onClick={onDelete}
          disabled={isDeleting}
          data-testid={`session-action-${sessionId}-delete`}
          className="border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
          title="Delete session"
        >
          {isDeleting ? <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> : <Trash2 className={iconSize} />}
          {!compact && <span className="ml-1.5">Delete</span>}
        </Button>
      ) : null}
    </div>
  );
};

export default SessionActionButtons;
