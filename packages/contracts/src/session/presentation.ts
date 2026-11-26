import { deriveSessionState } from './deriveStatus.js';
import {
  DESIRED_SESSION_EXECUTIONS,
  SESSION_EXECUTION_CONDITIONS,
  SYSTEM_PAUSE_CAUSE_CODES,
  type DesiredSessionExecution,
  type SessionExecutionCondition,
  type SessionInteractionType,
  type SessionPauseReason,
  type SessionStatus,
  type SystemPauseCauseCode,
} from './types.js';

export type SessionDisplayKind =
  | 'idle'
  | 'running'
  | 'stopped'
  | 'recovering'
  | 'waiting_approval'
  | 'waiting_credits'
  | 'waiting_runner'
  | 'waiting_prerequisite'
  | 'completed';

export const SESSION_DISPLAY_KINDS = [
  'idle',
  'running',
  'stopped',
  'recovering',
  'waiting_approval',
  'waiting_credits',
  'waiting_runner',
  'waiting_prerequisite',
  'completed',
] as const;

export interface SessionPresentationInput {
  desiredExecution?: DesiredSessionExecution | null;
  condition?: SessionExecutionCondition | null;
  conditionReason?: string | null;
  /** Legacy compatibility fields. New consumers must send the canonical pair. */
  status?: string | null;
  pauseReason?: SessionPauseReason | null;
  interactionType?: SessionInteractionType | null;
  blockedReason?: string | null;
  blockedMetaCode?: unknown;
}

export interface SessionPresentation {
  desiredExecution: DesiredSessionExecution;
  condition: SessionExecutionCondition;
  conditionReason: string | null;
  /** Legacy projection retained only while response consumers migrate. */
  status: SessionStatus;
  pauseReason: SessionPauseReason | null;
  interactionType: SessionInteractionType;
  blockedReason: string | null;
  kind: SessionDisplayKind;
  label: string;
  shortLabel: string;
  pulseAnimate: boolean;
  /** @deprecated Cancellation belongs to the run aggregate, never the session. */
  isTerminalCancellation: false;
  systemPauseCauseCode: SystemPauseCauseCode | null;
  systemPauseCauseLabel: string | null;
}

export interface SessionActionAvailability {
  showStop: boolean;
  showStart: boolean;
}

const DISPLAY_META: Record<
  SessionDisplayKind,
  Pick<SessionPresentation, 'label' | 'shortLabel' | 'pulseAnimate'>
> = {
  idle: { label: 'IDLE', shortLabel: 'IDLE', pulseAnimate: false },
  running: { label: 'RUNNING', shortLabel: 'RUNNING', pulseAnimate: true },
  stopped: { label: 'STOPPED', shortLabel: 'STOPPED', pulseAnimate: false },
  recovering: { label: 'RECOVERING', shortLabel: 'RECOVERING', pulseAnimate: true },
  waiting_approval: {
    label: 'WAITING FOR APPROVAL',
    shortLabel: 'WAITING (APPROVAL)',
    pulseAnimate: true,
  },
  waiting_credits: {
    label: 'WAITING FOR CREDITS',
    shortLabel: 'NO CREDITS',
    pulseAnimate: false,
  },
  waiting_runner: {
    label: 'WAITING FOR RUNNER',
    shortLabel: 'WAITING (RUNNER)',
    pulseAnimate: false,
  },
  waiting_prerequisite: {
    label: 'WAITING',
    shortLabel: 'WAITING',
    pulseAnimate: false,
  },
  completed: { label: 'COMPLETED', shortLabel: 'COMPLETED', pulseAnimate: false },
};

const isDesiredExecution = (value: unknown): value is DesiredSessionExecution =>
  DESIRED_SESSION_EXECUTIONS.includes(value as DesiredSessionExecution);

const isExecutionCondition = (value: unknown): value is SessionExecutionCondition =>
  SESSION_EXECUTION_CONDITIONS.includes(value as SessionExecutionCondition);

const legacyExecutionPair = (
  input: SessionPresentationInput,
): { desiredExecution: DesiredSessionExecution; condition: SessionExecutionCondition } => {
  const blockedReason = input.blockedReason ?? null;
  const legacy = deriveSessionState({ blockedReason });
  const status = input.status ?? legacy.status;
  const pauseReason = input.pauseReason ?? legacy.pauseReason;
  const desiredExecution: DesiredSessionExecution =
    blockedReason === 'user_paused'
    || blockedReason === 'aborted_by_user'
    || (status === 'paused' && pauseReason === 'manual')
      ? 'stopped'
      : 'running';

  if (status === 'completed') return { desiredExecution, condition: 'completed' };
  if (status === 'running') return { desiredExecution, condition: 'executing' };
  if (status === 'paused') {
    if (pauseReason === 'approval') return { desiredExecution, condition: 'waiting_approval' };
    if (pauseReason === 'credits') return { desiredExecution, condition: 'waiting_credits' };
    if (pauseReason === 'runner') return { desiredExecution, condition: 'waiting_runner' };
    if (pauseReason === 'system') return { desiredExecution, condition: 'recovering' };
  }
  // Legacy failed/error alone cannot prove unfinished journal work.
  return { desiredExecution, condition: 'idle' };
};

const resolveExecutionPair = (
  input: SessionPresentationInput,
): { desiredExecution: DesiredSessionExecution; condition: SessionExecutionCondition } =>
  isDesiredExecution(input.desiredExecution) && isExecutionCondition(input.condition)
    ? { desiredExecution: input.desiredExecution, condition: input.condition }
    : legacyExecutionPair(input);

const legacyStatusFor = (
  desiredExecution: DesiredSessionExecution,
  condition: SessionExecutionCondition,
): SessionStatus => {
  if (desiredExecution === 'stopped') return 'paused';
  if (condition === 'completed') return 'completed';
  if (condition === 'executing' || condition === 'recovering') return 'running';
  if (condition.startsWith('waiting_')) return 'paused';
  return 'idle';
};

const legacyPauseReasonFor = (
  desiredExecution: DesiredSessionExecution,
  condition: SessionExecutionCondition,
): SessionPauseReason | null => {
  if (desiredExecution === 'stopped') return 'manual';
  switch (condition) {
    case 'waiting_approval': return 'approval';
    case 'waiting_credits': return 'credits';
    case 'waiting_runner': return 'runner';
    case 'waiting_prerequisite':
    case 'recovering': return 'system';
    default: return null;
  }
};

export function resolveSystemPauseCauseCode(value: unknown): SystemPauseCauseCode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SYSTEM_PAUSE_CAUSE_CODES.includes(trimmed as SystemPauseCauseCode)
    ? trimmed as SystemPauseCauseCode
    : null;
}

export function formatSystemPauseCause(code: SystemPauseCauseCode | null | undefined): string {
  switch (code) {
    case 'closeout_pending': return 'report finalization is still in progress';
    case 'recovery_retry': return 'temporary recovery error';
    case 'worker_interrupted': return 'worker interruption';
    default: return 'temporary runtime interruption';
  }
}

export function resolveSessionDisplayKind(input: SessionPresentationInput = {}): SessionDisplayKind {
  const { desiredExecution, condition } = resolveExecutionPair(input);
  if (desiredExecution === 'stopped') return 'stopped';
  switch (condition) {
    case 'executing': return 'running';
    case 'recovering': return 'recovering';
    case 'waiting_approval': return 'waiting_approval';
    case 'waiting_credits': return 'waiting_credits';
    case 'waiting_runner': return 'waiting_runner';
    case 'waiting_prerequisite': return 'waiting_prerequisite';
    case 'completed': return 'completed';
    case 'idle':
    default: return 'idle';
  }
}

export function resolveSessionPresentation(input: SessionPresentationInput = {}): SessionPresentation {
  const pair = resolveExecutionPair(input);
  const kind = resolveSessionDisplayKind(input);
  const meta = kind === 'waiting_prerequisite' && input.conditionReason === 'provider_quota_exhausted'
    ? {
        ...DISPLAY_META.waiting_prerequisite,
        label: 'WAITING FOR SUBSCRIPTION LIMIT',
        shortLabel: 'SUBSCRIPTION LIMIT',
      }
    : DISPLAY_META[kind];
  const systemPauseCauseCode = kind === 'recovering'
    ? resolveSystemPauseCauseCode(input.blockedMetaCode)
    : null;
  return {
    ...pair,
    conditionReason: input.conditionReason ?? null,
    status: legacyStatusFor(pair.desiredExecution, pair.condition),
    pauseReason: legacyPauseReasonFor(pair.desiredExecution, pair.condition),
    interactionType: 'none',
    blockedReason: input.blockedReason ?? null,
    kind,
    ...meta,
    isTerminalCancellation: false,
    systemPauseCauseCode,
    systemPauseCauseLabel: kind === 'recovering'
      ? formatSystemPauseCause(systemPauseCauseCode)
      : null,
  };
}

export function resolveSessionActions(input: SessionPresentationInput = {}): SessionActionAvailability {
  const { desiredExecution, condition } = resolveExecutionPair(input);
  return {
    showStop: desiredExecution === 'running'
      && condition !== 'idle'
      && condition !== 'completed',
    showStart: desiredExecution === 'stopped' || condition === 'completed',
  };
}

export function canAcceptSessionInput(input: SessionPresentationInput = {}): boolean {
  const { desiredExecution, condition } = resolveExecutionPair(input);
  return desiredExecution === 'stopped' || condition === 'idle' || condition === 'completed';
}
