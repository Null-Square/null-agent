import { StatusPill, type StatusTone } from '../StatusPill';
// Declared here rather than imported: the kit is consumed by four services and
// cannot reach into one of them for a type. These two unions are the run
// contract's, and a mismatch surfaces as a compile error at every call site.
type RunPauseReason = 'manual' | 'approval' | 'credits' | 'runner' | 'system';
type RunInteractionType = 'none' | 'plan_approval';

interface RunStatusInfo {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
}

// Run status → the shared pill's tone. Running is live (signal), completed is a
// win (success), failed is a problem (destructive); attention pauses are warning
// and quiet states (queued / cancelled / recoverable pause) are neutral.
const BASE_STATUS: Record<string, RunStatusInfo> = {
  queued: { tone: 'neutral', label: 'Queued' },
  running: { tone: 'signal', label: 'Running', pulse: true },
  completed: { tone: 'success', label: 'Completed' },
  failed: { tone: 'destructive', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  canceled: { tone: 'neutral', label: 'Cancelled' },
};

function pausedInfo(
  pauseReason?: RunPauseReason | null,
  interactionType?: RunInteractionType | null,
): RunStatusInfo {
  if (interactionType === 'plan_approval') return { tone: 'warning', label: 'Plan Approval', pulse: true };
  if (pauseReason === 'approval') return { tone: 'warning', label: 'Awaiting Approval', pulse: true };
  if (pauseReason === 'credits') return { tone: 'warning', label: 'No Credits' };
  if (pauseReason === 'runner') return { tone: 'warning', label: 'Runner Offline', pulse: true };
  if (pauseReason === 'system') return { tone: 'neutral', label: 'Recoverable Pause' };
  return { tone: 'neutral', label: 'Paused' };
}

function getRunStatusInfo(
  status: string | null | undefined,
  pauseReason?: RunPauseReason | null,
  interactionType?: RunInteractionType | null,
): RunStatusInfo {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'paused') return pausedInfo(pauseReason, interactionType);
  return (
    BASE_STATUS[normalized] ?? {
      tone: 'neutral',
      label: normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Unknown',
    }
  );
}

export function RunStatusBadge({
  status,
  pauseReason,
  interactionType,
}: {
  status: string | null | undefined;
  pauseReason?: RunPauseReason | null;
  interactionType?: RunInteractionType | null;
}) {
  const info = getRunStatusInfo(status, pauseReason, interactionType);
  return (
    <StatusPill tone={info.tone} pulse={info.pulse}>
      {info.label}
    </StatusPill>
  );
}
