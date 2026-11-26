import * as React from 'react';
import { cn } from '../cn';

export interface CornerFrameProps {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * CornerFrame - Corner bracket decoration
 * Wraps content with decorative corner brackets
 */
export const CornerFrame: React.FC<CornerFrameProps> = ({ children, size = 'md', className }) => {
  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-6 h-6',
  };

  const offsetClasses = {
    sm: '-top-1 -left-1 -bottom-1 -right-1',
    md: '-top-2 -left-2 -bottom-2 -right-2',
    lg: '-top-3 -left-3 -bottom-3 -right-3',
  };

  return (
    <div className={cn('relative', className)}>
      {/* Corner Brackets */}
      <div
        className={cn(
          'absolute border-l-2 border-t-2 border-ns-yellow/50',
          sizeClasses[size],
          offsetClasses[size].split(' ').slice(0, 2).join(' ')
        )}
        style={{
          top: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
          left: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
        }}
      />
      <div
        className={cn('absolute border-r-2 border-t-2 border-ns-yellow/50', sizeClasses[size])}
        style={{
          top: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
          right: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
        }}
      />
      <div
        className={cn('absolute border-l-2 border-b-2 border-ns-yellow/50', sizeClasses[size])}
        style={{
          bottom: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
          left: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
        }}
      />
      <div
        className={cn('absolute border-r-2 border-b-2 border-ns-yellow/50', sizeClasses[size])}
        style={{
          bottom: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
          right: size === 'sm' ? '-0.25rem' : size === 'md' ? '-0.5rem' : '-0.75rem',
        }}
      />
      {children}
    </div>
  );
};
