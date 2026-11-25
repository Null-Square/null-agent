import React from 'react';

import { cn } from './cn';

export type BadgeStatus =
  | 'active'
  | 'inactive'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'pending';

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  status?: BadgeStatus;
  variant?: BadgeVariant;
}

const statusStyles: Record<BadgeStatus, string> = {
  active: 'border-success text-success bg-success/10',
  success: 'border-success text-success bg-success/10',
  completed: 'border-success text-success bg-success/10',
  warning: 'border-warning text-warning bg-warning/10',
  pending: 'border-warning text-warning bg-warning/10',
  error: 'border-destructive text-destructive bg-destructive/10',
  failed: 'border-destructive text-destructive bg-destructive/10',
  inactive: 'border-border text-muted-foreground bg-muted/40',
  suspended: 'border-border text-muted-foreground bg-muted/40',
  // Info is the neutral info token, not primary — the brand yellow stays reserved for action.
  info: 'border-info text-info bg-info/10',
};

// A badge is a label, not the primary action — so the DEFAULT is neutral, never
// the brand yellow. (Yellow is the one primary action per view.)
const variantStyles: Record<BadgeVariant, string> = {
  default: 'border-transparent bg-secondary text-secondary-foreground',
  secondary: 'border-transparent bg-secondary text-secondary-foreground',
  destructive: 'border-transparent bg-destructive text-destructive-foreground',
  outline: 'border-border text-foreground',
};

const dotColors: Record<BadgeStatus, string> = {
  active: 'bg-success',
  success: 'bg-success',
  completed: 'bg-success',
  warning: 'bg-warning',
  pending: 'bg-warning',
  error: 'bg-destructive',
  failed: 'bg-destructive',
  inactive: 'bg-muted-foreground',
  suspended: 'bg-muted-foreground',
  info: 'bg-info',
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, status, variant = 'default', children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono font-bold uppercase tracking-wide border transition-colors';
    const shouldAnimate = status === 'active' || status === 'pending';

    return (
      <span
        ref={ref}
        className={cn(baseStyles, status ? statusStyles[status] : variantStyles[variant], className)}
        {...props}
      >
        {status && (
          <span
            aria-hidden
            className={cn('w-1.5 h-1.5 flex-none', dotColors[status])}
            /* `ns-blink`, not `animate-pulse`: the brand has exactly one live
               animation and it is a discrete flicker — every cell is on or off,
               never fading through. Matches `StatusPill`, which is the same
               mark doing the same job. */
            style={shouldAnimate ? { animation: 'ns-blink 1.1s steps(1) infinite' } : undefined}
          />
        )}
        {children}
      </span>
    );
  },
);

Badge.displayName = 'Badge';
