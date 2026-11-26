import React from 'react';

import { cn } from '../cn';
import {
  TIMING_AXES,
  deriveTimingModel,
  fromFraction,
  spansInFocus,
  toFraction,
  zoomTimingFocus,
  type TimingAxis,
  type TimingFocus,
  type TimingLane,
  type TimingSpanInput,
} from './timingModel';

/**
 * TimingLanes — where the time went, on an axis you chose.
 *
 * A fixed strip above a record stream, not a tab beside it. Timing is the
 * question you ask *about the rows you are reading*, so sending the reader to
 * another view to ask it loses the rows and the question together.
 *
 * It is a chart, so it obeys the chart rules: no axis rule, no gridlines, no
 * legend, no frame. Lane names label a measurement and set in mono. The strip is
 * built from `deriveTimingModel`, which is where every decision about what a
 * projection may claim actually lives.
 *
 * Colour is the alpha ladder, never the severity ramp: a lane is not a severity.
 * The one exception is a span that failed, which takes the finding colour,
 * matching how the kit already marks an error field and an error toast.
 */

export interface TimingLanesProps {
  lanes: TimingLane[];
  spans: TimingSpanInput[];
  axis: TimingAxis;
  onAxisChange?: (axis: TimingAxis) => void;
  /** The committed interval, in the domain units of the current axis. */
  focus?: TimingFocus | null;
  onFocusChange?: (focus: TimingFocus | null) => void;
  /** Highlighted without narrowing — the row the reader has selected. */
  activeId?: string | null;
  onSelect?: (id: string) => void;
  /** Rendered under the strip. Say what a span means here, not what a chart is. */
  caption?: React.ReactNode;
  className?: string;
}

const AXIS_LABEL: Record<TimingAxis, string> = {
  sequence: 'Sequence',
  duration: 'Duration',
  time: 'Time',
  actual: 'Actual',
};

const AXIS_HINT: Record<TimingAxis, string> = {
  sequence: 'Causal order. The only axis that can show every record.',
  duration: 'Measured work, idle removed. Not a clock reading.',
  time: 'Wall clock, long idle compressed.',
  actual: 'Wall clock at true scale.',
};

const LANE_HEIGHT = 22;

export const TimingLanes: React.FC<TimingLanesProps> = ({
  lanes,
  spans,
  axis,
  onAxisChange,
  focus = null,
  onFocusChange,
  activeId = null,
  onSelect,
  caption,
  className,
}) => {
  const strip = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<{ from: number; to: number } | null>(null);

  const model = React.useMemo(
    () => deriveTimingModel({ spans, lanes, axis }),
    [spans, lanes, axis],
  );
  const focused = React.useMemo(
    () => (focus ? spansInFocus(model, focus) : null),
    [model, focus],
  );

  const domainAt = React.useCallback(
    (clientX: number): number => {
      const box = strip.current?.getBoundingClientRect();
      if (!box || box.width === 0) return model.domainStart;
      return fromFraction(model, (clientX - box.left) / box.width);
    },
    [model],
  );

  const commit = (next: { from: number; to: number } | null) => {
    if (!next) {
      onFocusChange?.(null);
      return;
    }
    const from = Math.min(next.from, next.to);
    const to = Math.max(next.from, next.to);
    // A click is not a drag. Anything narrower than a pixel's worth of domain is
    // the reader tapping the strip, and clearing is the friendlier reading.
    if (to - from < (model.domainEnd - model.domainStart) / 400) {
      onFocusChange?.(null);
      return;
    }
    onFocusChange?.({ from, to });
  };

  const region = focus ?? drag;

  return (
    <section className={cn('w-full', className)} aria-label="Record timing">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex items-center" role="group" aria-label="Timing axis">
          {TIMING_AXES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={axis === option}
              title={AXIS_HINT[option]}
              onClick={() => onAxisChange?.(option)}
              className={cn(
                'border border-border px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em]',
                '-ml-px first:ml-0 focus-visible:relative focus-visible:z-10',
                axis === option
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {AXIS_LABEL[option]}
            </button>
          ))}
        </div>

        {model.omitted > 0 && (
          <p className="font-mono text-[10.5px] text-muted-foreground" role="status">
            {model.omitted} without known timing — visible on Sequence
          </p>
        )}

        {focus && (
          <button
            type="button"
            onClick={() => onFocusChange?.(null)}
            className="ml-auto font-mono text-[10.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear focus
          </button>
        )}
      </div>

      <div
        ref={strip}
        className="relative select-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || !onFocusChange) return;
          const at = domainAt(event.clientX);
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ from: at, to: at });
        }}
        onPointerMove={(event) => {
          if (!drag) return;
          setDrag({ from: drag.from, to: domainAt(event.clientX) });
        }}
        onPointerUp={(event) => {
          if (!drag) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          commit({ from: drag.from, to: domainAt(event.clientX) });
          setDrag(null);
        }}
        onContextMenu={(event) => {
          if (!onFocusChange) return;
          event.preventDefault();
          onFocusChange(null);
        }}
        onWheel={(event) => {
          if (!onFocusChange || !event.ctrlKey) return;
          event.preventDefault();
          onFocusChange(
            zoomTimingFocus(model, focus, domainAt(event.clientX), event.deltaY > 0 ? 1.25 : 0.8),
          );
        }}
      >
        {region && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 z-10 border-x border-border-strong bg-foreground/[0.06]"
            style={{
              left: `${toFraction(model, Math.min(region.from, region.to)) * 100}%`,
              width: `${Math.max(
                0,
                toFraction(model, Math.max(region.from, region.to))
                  - toFraction(model, Math.min(region.from, region.to)),
              ) * 100}%`,
            }}
          />
        )}

        {model.lanes.map(({ lane, spans: laneSpans }) => (
          <div
            key={lane.id}
            className="grid grid-cols-[68px_minmax(0,1fr)] items-center gap-3 border-t border-border first:border-t-0"
          >
            <span className="py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {lane.label}
            </span>
            <div className="relative" style={{ height: LANE_HEIGHT }}>
              {laneSpans.map((span) => {
                const left = toFraction(model, span.start);
                const width = toFraction(model, span.end) - left;
                const dimmed = focused ? !focused.has(span.id) : false;
                return (
                  <button
                    key={span.id}
                    type="button"
                    title={span.label}
                    aria-label={span.label ?? span.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect?.(span.id);
                    }}
                    className={cn(
                      'absolute top-1/2 h-2 -translate-y-1/2',
                      span.failed ? 'bg-destructive' : 'bg-foreground/45',
                      activeId === span.id && 'h-3 bg-foreground',
                      dimmed && 'opacity-25',
                      // A drawn floor width is not a measurement, so it reads as
                      // a mark rather than a bar.
                      !span.measured && 'h-1.5',
                    )}
                    style={{
                      left: `${left * 100}%`,
                      width: `${Math.max(width * 100, 0.35)}%`,
                      minWidth: 3,
                    }}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {caption && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground">{caption}</p>
      )}
    </section>
  );
};
