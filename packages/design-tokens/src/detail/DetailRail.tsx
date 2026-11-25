import React from 'react';
import { cn } from '../cn';

/**
 * The rail's three parts.
 *
 * Brand system, Chapter IV: the rail is **a workflow, not a properties list** —
 * a state, an owner, one primary verb, an optional secondary, and whatever the
 * run in flight needs to say. Every conditional block is driven by state the
 * page already holds; none of it is decoration.
 *
 * The rail's primary verb is the page's one yellow, which is why a detail tab
 * strip goes bone (`StatusTabs tone="bone"`).
 */

export interface DetailRailBlockProps {
  label?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const DetailRailBlock: React.FC<DetailRailBlockProps> = ({ label, children, className }) => (
  <div className={cn('flex flex-col gap-4', className)}>
    {label ? (
      <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
    ) : null}
    {children}
  </div>
);

export interface DetailRailFieldProps {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const DetailRailField: React.FC<DetailRailFieldProps> = ({ label, children, className }) => (
  <div className={cn('flex flex-col gap-2', className)}>
    <span className="text-xs font-medium text-muted-foreground">{label}</span>
    {children}
  </div>
);

// A note that reports an outcome needs `role="alert"` or `role="status"`, and
// callers were wrapping it in a bare div to get one — which is how the exposure
// page silently lost both when it moved onto this kit. Pass the div's own
// attributes straight through instead.
export interface DetailRailNoteProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  /** `live` marks a run in flight — the one place the rail carries the signal. */
  tone?: 'default' | 'live' | 'warning' | 'destructive';
  children: React.ReactNode;
}

const NOTE_TONE: Record<NonNullable<DetailRailNoteProps['tone']>, string> = {
  default: 'border-l-border',
  live: 'border-l-primary',
  warning: 'border-l-warning',
  destructive: 'border-l-destructive',
};

export const DetailRailNote: React.FC<DetailRailNoteProps> = ({
  title,
  tone = 'default',
  children,
  className,
  ...rest
}) => (
  <div {...rest} className={cn('border-l-2 pl-4', NOTE_TONE[tone], className)}>
    {title ? <div className="mb-1.5 text-sm font-semibold text-foreground">{title}</div> : null}
    <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
  </div>
);
