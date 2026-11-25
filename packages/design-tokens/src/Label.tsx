import React from 'react';

import { cn } from './cn';

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ required, className, children, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(
        // A label is chrome, not data — mono/uppercase/wide-tracking is
        // reserved for real system data elsewhere in this kit.
        'block text-xs font-semibold text-muted-foreground mb-1.5',
        className,
      )}
      {...props}
    >
      {children}
      {required && <span className="text-primary ml-1">*</span>}
    </label>
  ),
);

Label.displayName = 'Label';
