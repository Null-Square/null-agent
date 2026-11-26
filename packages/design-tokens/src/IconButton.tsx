import React from 'react';

import { cn } from './cn';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ active = false, className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'p-2 border transition-all duration-0 disabled:opacity-50 disabled:cursor-not-allowed',
        active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card text-foreground border-border hover:border-primary hover:text-primary',
        className,
      )}
      {...props}
    />
  ),
);

IconButton.displayName = 'IconButton';
