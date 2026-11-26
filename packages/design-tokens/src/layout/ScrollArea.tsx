import * as React from 'react';
import { cn } from '../cn';

export interface ScrollAreaProps {
  children: React.ReactNode;
  height?: string;
  className?: string;
}

/**
 * ScrollArea - Scroll container with branded scrollbar
 * Yellow thumb on hover, dark track
 */
export const ScrollArea: React.FC<ScrollAreaProps> = ({
  children,
  height = 'h-64',
  className,
}) => {
  return (
    <div
      className={cn(
        height,
        'overflow-y-auto',
        'scrollbar-thin scrollbar-thumb-ns-elevated scrollbar-track-ns-surface',
        'hover:scrollbar-thumb-ns-yellow',
        className
      )}
    >
      {children}
    </div>
  );
};
