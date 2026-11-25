import React from 'react';

import { cn } from './cn';

/**
 * NativeSelect — the OS select, for the cases that genuinely want one (long
 * option lists, mobile pickers). Sized and coloured to match `Select` so the
 * two never read as different controls sitting next to each other.
 */
export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'flex h-[46px] w-full rounded-none border border-border bg-transparent px-4 text-sm text-foreground transition-colors',
      'hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-destructive',
      className,
    )}
    {...props}
  />
));

NativeSelect.displayName = 'NativeSelect';
