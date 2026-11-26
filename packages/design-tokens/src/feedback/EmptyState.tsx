
import React from 'react';
import { Ghost } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  dashed?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon = Ghost,
  title,
  description,
  action,
  dashed = true
}) => {
  return (
    <div className={`
      w-full flex flex-col items-center justify-center p-12 text-center bg-background/50
      ${dashed ? 'border border-dashed border-border' : 'border border-border'}
    `}>
      <div className="w-16 h-16 mb-4 flex items-center justify-center bg-surface-2 border border-border text-muted-foreground">
        <Icon size={32} />
      </div>
      
      <h4 className="text-heading font-medium mb-2">
        {title}
      </h4>
      
      {description && (
        <p className="text-muted-foreground text-xs font-mono max-w-xs mb-6">
          {description}
        </p>
      )}

      {action && (
        <div className="mt-2">
          {action}
        </div>
      )}
    </div>
  );
};
