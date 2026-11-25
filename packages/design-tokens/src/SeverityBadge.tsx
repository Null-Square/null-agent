import React from 'react';

import { cn } from './cn';

/**
 * SeverityBadge — the ONE severity tag, shared by every service.
 *
 * Replaces the per-app severity badges that each hand-rolled their own colours.
 * Follows the brand system's severity spec: a boxed mono tag, uppercase, drawn
 * from the severity tokens (never raw palette colours). Critical is filled (the
 * one loud tier); the rest are a coloured outline; info is neutral bone.
 *
 * Severity colour is the product-frame exception in the brand — this component
 * is a product-frame element, so the ramp is allowed here and only here.
 */

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

// One family, one shape: every tier is a filled chip in its ramp colour with
// black text. Severity is a fixed five-tier scale, so the tiers must differ by
// colour alone — an outline for three of them and a fill for the fourth made
// critical read as a different kind of object instead of the top of a scale.
const SEVERITY_STYLES: Record<SeverityLevel, string> = {
  critical: 'bg-critical text-black',
  high: 'bg-high text-black',
  medium: 'bg-medium text-black',
  low: 'bg-low text-black',
  // Info is not a severity that asks for anything, so it takes the quietest
  // fill in the family rather than dropping out of it.
  info: 'bg-muted-foreground/70 text-black',
};

const SEVERITY_LABELS: Record<SeverityLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Info',
};

const LEVELS = new Set<SeverityLevel>(['critical', 'high', 'medium', 'low', 'info']);

const normalizeSeverity = (value: string | null | undefined): SeverityLevel =>
  (LEVELS.has((value ?? '').toLowerCase() as SeverityLevel)
    ? ((value as string).toLowerCase() as SeverityLevel)
    : 'info');

export interface SeverityBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  severity: SeverityLevel | string | null | undefined;
  /** Override the rendered text (defaults to the capitalized severity). */
  label?: string;
}

export const SeverityBadge = React.forwardRef<HTMLSpanElement, SeverityBadgeProps>(
  ({ severity, label, className, ...props }, ref) => {
    const level = normalizeSeverity(typeof severity === 'string' ? severity : undefined);
    const text =
      label ??
      (typeof severity === 'string' && !LEVELS.has(severity.toLowerCase() as SeverityLevel)
        ? severity
        : SEVERITY_LABELS[level]);
    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center whitespace-nowrap px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.08em]',
          SEVERITY_STYLES[level],
          className,
        )}
        {...props}
      >
        {text}
      </span>
    );
  },
);

SeverityBadge.displayName = 'SeverityBadge';
