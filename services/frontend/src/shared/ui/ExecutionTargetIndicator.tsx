import { Monitor, Server } from 'lucide-react';
import { cn } from '@shared/lib/utils';
import type { ExecutionTarget } from '@shared/types/execution';

interface ExecutionTargetIndicatorProps {
  target: ExecutionTarget | null | undefined;
  runnerName?: string | null;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

export function ExecutionTargetIndicator({
  target,
  runnerName,
  className,
  size = 'md',
  showLabel = true,
}: ExecutionTargetIndicatorProps) {
  if (!target) return null;

  const isScopeRunner = target === 'scope_runner';

  // Styling maps
  const sizeClasses = {
    sm: 'text-[9px] px-2 py-0.5 gap-1.5',
    md: 'text-[10px] px-2.5 py-1 gap-2',
    lg: 'text-xs px-3 py-1.5 gap-2.5',
  };

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-3.5 w-3.5',
    lg: 'h-4 w-4',
  };

  // Base styling for the indicator
  const baseClasses =
    'inline-flex items-center font-mono uppercase tracking-[0.1em] font-bold transition-colors';

  // Origin is a tag, not the primary action — both states are neutral (the icon
  // distinguishes them). No yellow: the brand reserves it for the one action.
  const stateClasses = isScopeRunner
    ? 'text-foreground' // Private runner — brighter neutral
    : 'text-muted-foreground'; // This computer — quieter neutral

  return (
    <div
      className={cn(baseClasses, sizeClasses[size], stateClasses, className)}
      title={isScopeRunner ? `Private Runner Origin: ${runnerName ?? 'Unknown'}` : 'This computer'}
    >
      {isScopeRunner ? (
        <Server className={cn(iconSizes[size])} />
      ) : (
        <Monitor className={cn(iconSizes[size])} />
      )}
      {showLabel && (
        <span className="truncate">
          {isScopeRunner ? runnerName ?? 'PRIVATE RUNNER' : 'THIS COMPUTER'}
        </span>
      )}
    </div>
  );
}
