import React from 'react';

import { cn } from '../cn';
import { CellField } from './CellField';

/**
 * WorkingOverlay — the screen takes over while something long is starting.
 *
 * This is deliberately a LOADING SCREEN and not a progress report. The work it
 * covers happens inside one request, so the browser cannot see any part of it
 * finish; a stepper with ticks would be inventing progress. What the captions
 * do instead is name the kind of work in flight, one line at a time, on a
 * cycle — ambient, never claiming a stage is complete, never counting.
 *
 * The field beneath them is the same lattice as everywhere else, sweeping
 * rather than bursting. Nothing spins; see `CellField`.
 */

export interface WorkingOverlayProps {
  open: boolean;
  /** e.g. "Preparing your assessment". */
  title: string;
  /** Cycled underneath, ~2.4s each. Name the kind of work, not a step number. */
  captions: string[];
  /** Shown once the wait is long enough that it needs acknowledging. */
  slowNote?: string;
  slowAfterMs?: number;
  className?: string;
}

const CAPTION_MS = 2400;

export const WorkingOverlay: React.FC<WorkingOverlayProps> = ({
  open,
  title,
  captions,
  slowNote = 'Still working. This can take a little longer under load.',
  slowAfterMs = 20_000,
  className,
}) => {
  const [index, setIndex] = React.useState(0);
  const [slow, setSlow] = React.useState(false);

  React.useEffect(() => {
    if (!open) { setIndex(0); setSlow(false); return undefined; }

    /* The captions hold on the last one rather than looping back to the first:
       a list that restarts tells the customer the wait restarted too. */
    const tick = window.setInterval(
      () => setIndex((i) => (i + 1 < captions.length ? i + 1 : i)),
      CAPTION_MS,
    );
    const slowTimer = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => { window.clearInterval(tick); window.clearTimeout(slowTimer); };
  }, [open, captions.length, slowAfterMs]);

  if (!open) return null;

  return (
    <div
      className={cn('fixed inset-0 z-[1100] flex items-center justify-center p-4', className)}
      role="status"
      aria-live="polite"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/88 backdrop-blur-[14px]" />

      <div className="relative flex w-full max-w-[520px] flex-col items-center px-6 py-10 text-center">
        <CellField mode="sweep" />

        <h2 className="mt-9 text-xl font-black leading-tight tracking-tight text-white">{title}</h2>

        {/* Fixed height so a longer caption cannot shift the layout under the
            one before it — the field has to look like it is holding still. */}
        <div className="mt-3 flex h-10 items-center justify-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-white/55">
            {captions[index] ?? captions[captions.length - 1]}
          </p>
        </div>

        {slow ? (
          <p className="mt-2 max-w-[40ch] text-[13px] leading-relaxed text-white/45">{slowNote}</p>
        ) : null}
      </div>
    </div>
  );
};
