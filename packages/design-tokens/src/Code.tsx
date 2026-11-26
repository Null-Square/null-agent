import React from 'react';

import { cn } from './cn';

export interface CodeProps extends React.HTMLAttributes<HTMLElement> {
  block?: boolean;
}

export const Code: React.FC<CodeProps> = ({ block = false, className, children, ...props }) => {
  if (block) {
    return (
      <pre
        className={cn(
          'bg-muted border border-border p-4 font-mono text-xs text-primary overflow-x-auto my-2',
          className,
        )}
        {...props}
      >
        <code>{children}</code>
      </pre>
    );
  }

  return (
    <code
      className={cn('bg-muted px-1 py-0.5 text-primary font-mono text-xs', className)}
      {...props}
    >
      {children}
    </code>
  );
};
