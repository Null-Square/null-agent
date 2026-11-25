import React from 'react';

import { cn } from './cn';

/**
 * StatusPill — the ONE lifecycle/status pill, shared by every service.
 *
 * Replaces the many per-app status badges (finding status, validation state,
 * confidence, exposure state, run status…) that each hand-rolled the same
 * markup with different raw colours and round dots.
 *
 * Brand system `.pill` spec: a meaningful state (running / verified / failed…)
 * is an outline pill with a SQUARE status mark (the brand has no status
 * circles); a NEUTRAL state is plain muted text — no border, no dot — so a
 * quiet "Open" never competes with a live "Testing" or a red "Failed". Tones
 * map to tokens only, and `signal` (live / running) is the only one that
 * carries the brand yellow.
 */

export type StatusTone = 'neutral' | 'signal' | 'success' | 'warning' | 'destructive';

// A lifecycle state is a WORD, graded by colour. Nothing is framed: the filled
// chip belongs to severity, and a frame on top of a red word was the same
// redundancy one level down. The only thing ever added is the blinking square,
// and it means exactly one thing — live.
const TONE_TEXT: Record<StatusTone, string> = {
  neutral: 'text-muted-foreground',
  signal: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  /** Show the leading square status mark on coloured tones. Default true. */
  showDot?: boolean;
  /** @deprecated Live states always blink; the tone decides. Kept so existing
   *  callers do not break. */
  pulse?: boolean;
}

export const StatusPill = React.forwardRef<HTMLSpanElement, StatusPillProps>(
  ({ tone = 'neutral', showDot = true, pulse = false, className, children, ...props }, ref) => {
    // Live is the only state that carries the square, and it always blinks.
    const isLive = tone === 'signal' && showDot;

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex w-fit items-center gap-2 whitespace-nowrap text-xs font-medium',
          TONE_TEXT[tone],
          className,
        )}
        {...props}
      >
        {isLive ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 flex-none bg-primary"
            style={{ animation: 'ns-blink 1.1s steps(1) infinite' }}
          />
        ) : null}
        {children}
      </span>
    );
  },
);

StatusPill.displayName = 'StatusPill';
