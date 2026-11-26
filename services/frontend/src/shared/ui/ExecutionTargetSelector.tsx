import { Monitor, Server } from 'lucide-react';
import { cn } from '@shared/lib/utils';
import type { ExecutionTarget } from '@shared/types/execution';

interface ExecutionTargetSelectorProps {
  value: ExecutionTarget;
  onChange: (target: ExecutionTarget) => void;
  runnerName?: string | null;
  runnerLocked?: boolean;
  runnerLockedReason?: string | null;
  className?: string;
  disabled?: boolean;
}

export function ExecutionTargetSelector({
  value,
  onChange,
  runnerName,
  runnerLocked = false,
  runnerLockedReason,
  className,
  disabled = false,
}: ExecutionTargetSelectorProps) {
  const isCloud = value === 'cloud';
  const isScopeRunner = value === 'scope_runner';

  // Ensure runnerName is provided if scope_runner is selected or available
  const hasRunner = Boolean(runnerName);
  const runnerDisabled = disabled || !hasRunner || runnerLocked;
  const runnerTitle = !hasRunner
    ? 'No private execution node attached'
    : runnerLockedReason ?? undefined;

  return (
    <div
      className={cn(
        // The lattice: cells on a 1px seam inside one hairline, square, no
        // blur — the same construction as the kit's SegmentedControl.
        'inline-flex gap-px border border-border bg-border',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange('cloud')}
        className={cn(
          'flex items-center gap-2 px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors',
          isCloud
            ? 'bg-foreground text-background'
            : 'bg-background text-muted-foreground hover:text-foreground'
        )}
      >
        <Monitor className="h-3.5 w-3.5" />
        This computer
      </button>

      {hasRunner && (
        <>
          <button
            type="button"
            disabled={runnerDisabled}
            onClick={() => onChange('scope_runner')}
            title={runnerTitle}
            className={cn(
              'flex items-center gap-2 px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors',
              isScopeRunner
                ? 'bg-foreground text-background'
                : !runnerLocked
                ? 'bg-background text-muted-foreground hover:text-foreground'
                : 'bg-background text-muted-foreground/30'
            )}
          >
            <Server className="h-3.5 w-3.5" />
            {runnerName}
          </button>
        </>
      )}
    </div>
  );
}
