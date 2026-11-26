import React from 'react';
import { Check } from 'lucide-react';

import { cn } from './cn';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className, checked, disabled, onCheckedChange, onChange, ...props }, ref) => {
    const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(event.target.checked);
      onChange?.(event);
    };

    return (
      <label
        className={cn(
          'flex items-center gap-3 select-none',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          onChange={handleChange}
          {...props}
        />
        <span
          data-state={checked ? 'checked' : 'unchecked'}
          className={cn(
            'flex h-5 w-5 items-center justify-center border transition-colors peer-focus-visible:ring-2',
            className,
          )}
          style={{
            borderColor: checked ? 'var(--color-primary)' : 'var(--color-border)',
            backgroundColor: checked ? 'var(--color-primary)' : 'var(--color-input)',
          }}
        >
          <Check 
            className="h-3.5 w-3.5"
            style={{ 
              color: checked ? 'var(--color-primary-foreground)' : 'transparent',
            }}
          />
        </span>
        {label && (
          <span 
            className="text-sm font-mono"
            style={{ color: checked ? 'var(--color-foreground)' : 'var(--color-muted-foreground)' }}
          >
            {label}
          </span>
        )}
      </label>
    );
  },
);

Checkbox.displayName = 'Checkbox';
