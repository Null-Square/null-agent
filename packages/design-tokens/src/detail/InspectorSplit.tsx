import React from 'react';
import { X } from 'lucide-react';

import { cn } from '../cn';

/**
 * InspectorSplit — a stream that owns the screen, and a detail pane that only
 * exists once you have selected something.
 *
 * `RailLayout` is the arrangement for a *record*: a thing with properties and a
 * verb, where the rail is worth 360px on arrival because the reader came to act
 * on it. A **stream** is not that. Nobody opens a trace to read the rail, and a
 * permanent 360px column beside it spends a fifth of the page on the answer to
 * a question the reader has not asked yet — while the rows, which are the whole
 * reason the page exists, get truncated to make room.
 *
 * So the geometry follows the selection. With nothing selected the stream has
 * the page. Select a row and the pane opens beside it, carrying the record that
 * row could not fit; close it and the width goes straight back to the stream.
 * Space is spent when there is something to spend it on.
 *
 * ── IT IS NOT A THIRD COLUMN ──────────────────────────────────────────────
 * The kit's rule against a third column beside the main one and the rail still
 * holds, and this does not break it: a page using this arrangement has **no**
 * rail. There are two columns, and the second one is usually not there.
 *
 * ── AND THE READER SETS THE BALANCE ───────────────────────────────────────
 * The divider is draggable, because "how much of this screen is the stream" is
 * a judgement that changes by the minute — a wide payload wants the pane, and
 * scanning a hundred rows wants it gone. It is a real `separator` with real
 * arrow keys, not a hover affordance, since a control that only exists for a
 * mouse is a control half the operators do not have.
 */

export interface InspectorSplitProps {
  /** The stream. It is given a pane exactly `height` tall and scrolls inside it. */
  children: React.ReactNode;
  /**
   * The selected record. `null` or absent closes the pane and hands the whole
   * width back — which is the state the page is in most of the time.
   */
  inspector?: React.ReactNode;
  /** Closes the pane. Absent leaves the pane open with no way out, so pass it. */
  onClose?: () => void;
  /** What the pane is showing, in the record's own vocabulary. Mono, dim. */
  eyebrow?: React.ReactNode;
  title?: React.ReactNode;
  /** The region's height in px — normally from `useFillHeight`. */
  height: number;
  /** Opening width for the pane. Clamped to what the region can spare. */
  defaultWidth?: number;
  /** Narrowest the pane goes before the drag stops. */
  minWidth?: number;
  /** Narrowest the stream is allowed to become. The pane never crosses it. */
  minStreamWidth?: number;
  className?: string;
}

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 300;
const MIN_STREAM_WIDTH = 360;
const KEY_STEP = 32;

/**
 * What the pane is allowed to be, given how much room there is.
 *
 * Pure, and exported, because this one line is what decides whether the stream
 * survives: a width the reader chose on a wide screen must not carry onto a
 * narrow one as a pane that leaves four columns of rows. When the two floors
 * cannot both be met the pane's floor wins and the region scrolls, because a
 * pane too narrow to read is worse than a stream too narrow to scan — you can
 * close the pane.
 *
 * `available` of zero means the region has not been laid out yet; there is
 * nothing to clamp against, so the asking width stands and the next
 * measurement corrects it.
 */
export function clampPaneWidth(
  value: number,
  available: number,
  minWidth = MIN_WIDTH,
  minStreamWidth = MIN_STREAM_WIDTH,
): number {
  if (!(available > 0)) return value;
  const ceiling = Math.max(minWidth, available - minStreamWidth);
  return Math.min(Math.max(value, minWidth), ceiling);
}

export const InspectorSplit: React.FC<InspectorSplitProps> = ({
  children,
  inspector = null,
  onClose,
  eyebrow,
  title,
  height,
  defaultWidth = DEFAULT_WIDTH,
  minWidth = MIN_WIDTH,
  minStreamWidth = MIN_STREAM_WIDTH,
  className,
}) => {
  const host = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(defaultWidth);

  // Read at draw time rather than stored, because the answer changes when the
  // window does and a stored width would outlive the screen it was chosen on.
  const clamp = React.useCallback(
    (value: number): number =>
      clampPaneWidth(
        value,
        host.current?.getBoundingClientRect().width ?? 0,
        minWidth,
        minStreamWidth,
      ),
    [minWidth, minStreamWidth],
  );

  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const region = host.current?.getBoundingClientRect();
    if (!region) return;
    event.preventDefault();

    const move = (moved: PointerEvent) => {
      setWidth(clamp(region.right - moved.clientX));
    };
    const release = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  const nudge = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setWidth((current) => clamp(current + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)));
  };

  return (
    <div
      ref={host}
      className={cn('flex min-h-0 w-full min-w-0 overflow-hidden border-t border-border', className)}
      style={{ height }}
    >
      <div className="min-w-0 flex-1 overflow-hidden">{children}</div>

      {inspector ? (
        <aside
          className="relative flex min-h-0 min-w-0 flex-none flex-col border-l border-border"
          style={{ width: clamp(width) }}
        >
          {/* The handle sits ON the seam, not beside it: a four-pixel target is
              unusable, so it is eight wide and hangs half over the pane. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the record pane"
            tabIndex={0}
            onPointerDown={drag}
            onKeyDown={nudge}
            className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:bg-primary/60"
          />

          <header className="flex h-9 flex-none items-center justify-between gap-3 border-b border-border pl-3 pr-1">
            <div className="flex min-w-0 items-baseline gap-2">
              {eyebrow ? (
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {eyebrow}
                </span>
              ) : null}
              {title ? (
                <span className="truncate text-[12px] font-semibold text-foreground">{title}</span>
              ) : null}
            </div>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close the record pane"
                className="flex h-7 w-7 flex-none items-center justify-center text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            ) : null}
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{inspector}</div>
        </aside>
      ) : null}
    </div>
  );
};
