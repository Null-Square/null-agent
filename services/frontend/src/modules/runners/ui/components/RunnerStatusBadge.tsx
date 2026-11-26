import { StatusPill, type StatusTone } from '@null-ai/design-tokens/ui';
import type { RunnerStatus } from '@/modules/security-ops/types';

interface RunnerStatusBadgeProps {
  status: RunnerStatus;
  healthState?: string;
  className?: string;
}

type DerivedState = 'online' | 'busy' | 'upgrade' | 'awaiting' | 'offline';

/**
 * RunnerStatusBadge — a runner's state, said once.
 *
 * It used to say it five times over: a rounded pill, a tinted ground, a
 * coloured border, a lucide icon, and a dot carrying an
 * `0 0 8px rgba(16,185,129,0.5)` glow — plus `backdrop-blur-sm` on a badge that
 * sits on an opaque table row. That is the entire vocabulary this brand
 * replaced, assembled in one component.
 *
 * A lifecycle state is a word graded by colour, which is what `StatusPill` is,
 * and the only mark it ever adds is the blink that means live. Busy is the one
 * live state here, so busy is the one that blinks.
 */
const STATE_VIEW: Record<DerivedState, { label: string; tone: StatusTone }> = {
  online: { label: 'Connected', tone: 'success' },
  busy: { label: 'Executing', tone: 'signal' },
  upgrade: { label: 'Upgrade required', tone: 'warning' },
  awaiting: { label: 'Initializing', tone: 'warning' },
  offline: { label: 'Offline', tone: 'destructive' },
};

export function RunnerStatusBadge({
  status,
  healthState = 'healthy',
  className,
}: RunnerStatusBadgeProps) {
  let derivedState: DerivedState = 'offline';
  if (healthState === 'awaiting_connect') derivedState = 'awaiting';
  else if (healthState === 'upgrade_required') derivedState = 'upgrade';
  else if (status === 'busy') derivedState = 'busy';
  else if (status === 'online') derivedState = 'online';

  const view = STATE_VIEW[derivedState];

  return (
    <StatusPill tone={view.tone} className={className}>
      {view.label}
    </StatusPill>
  );
}
