/** Frontend styling for the backend-owned session execution projection. */

export {
  type DesiredSessionExecution,
  type SessionExecutionCondition,
  type SessionInteractionType,
  type SessionPauseReason,
  type SessionStatus,
} from '@null-ai/contracts';
import {
  canAcceptSessionInput,
  deriveStatus,
  resolveSessionActions,
  resolveSessionPresentation,
  type SessionActionAvailability,
  type SessionDisplayKind,
  type SessionPresentationInput,
} from '@null-ai/contracts';

export { deriveStatus };

export interface StatusDisplayConfig {
  label: string;
  shortLabel: string;
  badgeVariant: 'default' | 'warning' | 'destructive' | 'secondary' | 'outline';
  bgClass: string;
  textClass: string;
  borderClass: string;
  pulseAnimate: boolean;
  icon: 'circle' | 'loader' | 'pause' | 'alert-circle' | 'x-circle' | 'check-circle';
  isPending: boolean;
}

export type SessionActions = SessionActionAvailability;

export interface EffectiveSessionRuntimeInput extends SessionPresentationInput {
  /** Legacy fields are accepted but never override the canonical pair. */
  isProcessing?: boolean | null;
  isTerminal?: boolean;
}

export interface EffectiveSessionRuntime {
  desiredExecution: 'running' | 'stopped';
  condition:
    | 'executing'
    | 'waiting_approval'
    | 'waiting_credits'
    | 'waiting_runner'
    | 'waiting_prerequisite'
    | 'recovering'
    | 'completed'
    | 'idle';
  conditionReason: string | null;
  status: string;
  pauseReason: import('@null-ai/contracts').SessionPauseReason | null;
  interactionType: 'none';
  blockedReason: string | null;
  isActivelyProcessing: boolean;
}

export function resolveEffectiveSessionRuntime(
  input: EffectiveSessionRuntimeInput,
): EffectiveSessionRuntime {
  const presentation = resolveSessionPresentation(input);
  return {
    desiredExecution: presentation.desiredExecution,
    condition: presentation.condition,
    conditionReason: presentation.conditionReason,
    status: presentation.status,
    pauseReason: presentation.pauseReason,
    interactionType: 'none',
    blockedReason: presentation.blockedReason,
    isActivelyProcessing: presentation.condition === 'executing',
  };
}

const DISPLAY_STYLE: Record<SessionDisplayKind, Omit<StatusDisplayConfig, 'label' | 'shortLabel' | 'pulseAnimate'>> = {
  idle: {
    badgeVariant: 'secondary', bgClass: 'bg-ns-elevated/30', textClass: 'text-ns-fg-muted',
    borderClass: 'border-ns-elevated/50', icon: 'circle', isPending: false,
  },
  running: {
    badgeVariant: 'warning', bgClass: 'bg-ns-yellow/15', textClass: 'text-ns-yellow',
    borderClass: 'border-ns-yellow/50', icon: 'loader', isPending: false,
  },
  stopped: {
    badgeVariant: 'secondary', bgClass: 'bg-muted', textClass: 'text-muted-foreground',
    borderClass: 'border-border', icon: 'pause', isPending: false,
  },
  recovering: {
    badgeVariant: 'warning', bgClass: 'bg-warning/15', textClass: 'text-warning',
    borderClass: 'border-warning/40', icon: 'loader', isPending: true,
  },
  waiting_approval: {
    badgeVariant: 'warning', bgClass: 'bg-warning/15', textClass: 'text-warning',
    borderClass: 'border-warning/50', icon: 'alert-circle', isPending: true,
  },
  waiting_credits: {
    badgeVariant: 'warning', bgClass: 'bg-warning/15', textClass: 'text-warning',
    borderClass: 'border-warning/50', icon: 'alert-circle', isPending: false,
  },
  waiting_runner: {
    badgeVariant: 'warning', bgClass: 'bg-warning/15', textClass: 'text-warning',
    borderClass: 'border-warning/50', icon: 'alert-circle', isPending: false,
  },
  waiting_prerequisite: {
    badgeVariant: 'warning', bgClass: 'bg-warning/15', textClass: 'text-warning',
    borderClass: 'border-warning/50', icon: 'alert-circle', isPending: false,
  },
  completed: {
    badgeVariant: 'outline', bgClass: 'bg-success/15', textClass: 'text-success',
    borderClass: 'border-success/30', icon: 'check-circle', isPending: false,
  },
};

export function getStatusDisplay(input: SessionPresentationInput = {}): StatusDisplayConfig {
  const presentation = resolveSessionPresentation(input);
  return {
    ...DISPLAY_STYLE[presentation.kind],
    label: presentation.label,
    shortLabel: presentation.shortLabel,
    pulseAnimate: presentation.pulseAnimate,
  };
}

export function getStatusActions(input: SessionPresentationInput = {}): SessionActions {
  return resolveSessionActions(input);
}

export const getSessionActions = getStatusActions;

export function isSessionBusy(input?: SessionPresentationInput): boolean {
  return resolveSessionPresentation(input).condition === 'executing';
}

export function isSessionPaused(input?: SessionPresentationInput): boolean {
  return resolveSessionPresentation(input).desiredExecution === 'stopped';
}

export function canAcceptInput(input: SessionPresentationInput = {}): boolean {
  return canAcceptSessionInput(input);
}

export function isSessionComplete(input: SessionPresentationInput = {}): boolean {
  return resolveSessionPresentation(input).condition === 'completed';
}
