import React from 'react';

import { cn } from './cn';

export interface SwitchProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: React.ReactNode;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, label, className, ...props }, ref) => {
    const control = (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative inline-flex h-5 w-10 items-center border border-border bg-input transition-colors rounded-none disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-primary bg-primary/10' : 'bg-input',
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 transform rounded-none bg-border transition-transform',
            checked ? 'translate-x-5 bg-primary' : 'translate-x-1',
          )}
        />
      </button>
    );

    if (!label) {
      return control;
    }

    return (
      <label className="inline-flex items-center gap-3 select-none cursor-pointer">
        {control}
        <span className="text-[10px] font-mono text-muted-foreground ">
          {label}
        </span>
      </label>
    );
  },
);

Switch.displayName = 'Switch';
