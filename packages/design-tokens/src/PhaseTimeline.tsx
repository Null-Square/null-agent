import React from 'react';

import { CellIcon, type CellIconName } from './CellIcon';
import { cn } from './cn';

/**
 * PhaseTimeline — a horizontal step timeline for a short, discrete pipeline.
 *
 * Square nodes only (the brand has no circles): success green, signal yellow
 * flickering for the active step (the one live mark), destructive red for a
 * failed step, a hollow hairline square for pending. A flat progress line
 * connects them — width encodes "how far in," not duration.
 *
 * For a duration-weighted, drill-into-detail timeline, see the run
 * observability panel instead — this component is for short fixed pipelines
 * (e.g. onboarding steps, a compact mission overview) where every step is a
 * discrete state, not a measured span.
 */

export type PhaseTimelineStepState = 'pass' | 'fail' | 'active' | 'pending';

export interface PhaseTimelineStep {
  id: string;
  label: string;
  state: PhaseTimelineStepState;
  /** Accessible name for the step — the visible label alone does not carry the
   *  state a screen reader needs, and the mark carries it in colour only. Used
   *  whether or not the step is a button. */
  ariaLabel?: string;
}

export interface PhaseTimelineProps {
  title?: string;
  icon?: CellIconName;
  steps: PhaseTimelineStep[];
  /** Render only the timeline — no frame, no header. For hosts that already
   *  provide a card, so the two headers do not stack. */
  bare?: boolean;
  /** Makes each step a button. Omit for a read-only timeline. */
  onStepClick?: (step: PhaseTimelineStep) => void;
  /** Marks the step whose detail is currently open. */
  activeStepId?: string | null;
  className?: string;
}

const STEP_LABEL_CLASSES: Record<PhaseTimelineStepState, string> = {
  active: 'text-foreground',
  pass: 'text-muted-foreground',
  fail: 'text-destructive',
  pending: 'text-muted-foreground/50',
};

const StepMark: React.FC<{ state: PhaseTimelineStepState }> = ({ state }) => {
  if (state === 'pass') return <div className="h-[11px] w-[11px] bg-success" />;
  if (state === 'fail') return <div className="h-[11px] w-[11px] bg-destructive" />;
  if (state === 'active') return <div className="ns-live-mark h-[11px] w-[11px] bg-primary" />;
  return <div className="h-[11px] w-[11px] border border-border bg-background" />;
};

export const PhaseTimeline: React.FC<PhaseTimelineProps> = ({
  title = 'Mission Progression',
  icon = 'runs',
  steps,
  bare = false,
  onStepClick,
  activeStepId,
  className,
}) => {
  let lastActiveIndex = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].state !== 'pending') {
      lastActiveIndex = i;
      break;
    }
  }
  const progressPercent = lastActiveIndex === -1 || steps.length <= 1
    ? 0
    : (lastActiveIndex / (steps.length - 1)) * 100;

  const timeline = (
    <div className={cn('relative overflow-hidden', bare ? 'px-2 py-6' : 'px-8 py-10')}>
      <div className={cn('absolute left-0 right-0 px-20', bare ? 'top-[29px]' : 'top-[45px]')}>
        <div className="relative h-[2px] w-full bg-border">
          <div
            className="absolute left-0 top-0 h-full bg-muted-foreground transition-all duration-500 ease-in-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Read-only, the mark is the *only* carrier of pass/active/fail/pending,
          and it carries it in colour. So the strip announces itself as a list of
          named states. Clickable steps are already buttons with their own
          accessible name, and stay exactly as they were. */}
      <div className="relative z-10 flex justify-between" role={onStepClick ? undefined : 'list'}>
        {steps.map((step) => {
          const isActive = activeStepId != null && activeStepId === step.id;
          const content = (
            <>
              <span className="mb-4 flex h-3 items-center justify-center bg-background px-1.5">
                <StepMark state={step.state} />
              </span>
              <span
                className={cn(
                  'text-center text-[13.5px] font-semibold leading-tight tracking-[-0.01em]',
                  STEP_LABEL_CLASSES[step.state],
                  isActive && 'text-foreground underline decoration-foreground/40 underline-offset-4',
                )}
              >
                {step.label}
              </span>
            </>
          );

          return onStepClick ? (
            <button
              key={step.id}
              type="button"
              onClick={() => onStepClick(step)}
              aria-label={step.ariaLabel ?? step.label}
              aria-expanded={isActive}
              className="flex w-24 flex-col items-center focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              {content}
            </button>
          ) : (
            <div
              key={step.id}
              role="listitem"
              aria-label={step.ariaLabel ?? step.label}
              className="flex w-24 flex-col items-center"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );

  if (bare) return <div className={cn('w-full', className)}>{timeline}</div>;

  return (
    <div className={cn('w-full border border-border bg-background', className)}>
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <CellIcon name={icon} size={18} />
          <h2 className="text-[14.5px] font-bold tracking-[-0.015em] text-foreground">{title}</h2>
        </div>
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          Phase Timeline
        </span>
      </div>
      {timeline}
    </div>
  );
};
