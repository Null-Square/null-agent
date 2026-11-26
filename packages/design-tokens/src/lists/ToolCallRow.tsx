import * as React from 'react';

import { cn } from '../cn';

/**
 * ToolCallRow — one thing the agent did, on one line, openable.
 *
 * A transcript is mostly tool calls, and a transcript where every one of them
 * renders as the same grey word followed by the same JSON blob is a wall. What
 * a reader is actually doing when they scan past forty of these is looking for
 * *the one that mattered*, and they find it by shape: the act on the left
 * always in the same place, the thing it acted on beside it, everything else
 * out of the way until asked for.
 *
 * So the row is four fixed slots and nothing else:
 *
 *   [mark] [icon] Read · workspace/report.md                          1.2s
 *
 * — the **act** (`title`) in sans, because it is a label the system chose; the
 * **subject** (`summary`) in mono, because it is data the run produced. That one
 * split does most of the work: a reader never has to parse which half of the
 * line is ours and which is the agent's.
 *
 * ── THE TINT IS THE FAMILY, NOT THE SEVERITY ────────────────────────────
 * `tone` takes a `--ns-trace-*` token and colours the icon and the act. It says
 * what kind of thing this was — a tool, a delegated worker, context put in
 * front of the model. It is never the severity ramp, and a failed row does not
 * change its tint: failure is the finding-coloured leading seam plus the
 * failure line in the summary slot, exactly as the kit marks an error field.
 *
 * ── AND IT DOES NOT ANIMATE ─────────────────────────────────────────────
 * Open or closed, no height transition, and a running call is marked by
 * `ns-blink` on the mark — the one live animation this brand has.
 */

export type ToolCallState = 'ok' | 'running' | 'failed';

export interface ToolCallRowProps {
  /** What kind of act this was: `Read`, `Search`, `Skill`, `Report`. Sans. */
  title: string;
  /** What it acted on: a path, a query, a skill's name. Mono — it is data. */
  summary?: React.ReactNode;
  /** A `CellIcon` (or any 14–16px mark) for the tool's family. */
  icon?: React.ReactNode;
  /** A `--ns-trace-*` token. Colours the icon and the act, never the failure. */
  tone?: string;
  state?: ToolCallState;
  /** Pinned to the trailing edge. A duration, kept short. */
  meta?: React.ReactNode;
  /** What opening the row reveals. Absent means the row does not open. */
  children?: React.ReactNode;
  /** Marks the row as the one the inspector is showing. */
  selected?: boolean;
  /** Rendered under the body — "open the full record". */
  footer?: React.ReactNode;
  /**
   * Told when the row opens or closes.
   *
   * A row's body is often bigger than the list can afford to carry for every
   * row at once — a tool result is a file, a page, a scan. The owner uses this
   * to fetch the whole of it on open, so the collapsed list stays a list.
   */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

const Mark: React.FC<{ open: boolean; running: boolean }> = ({ open, running }) => (
  <span
    aria-hidden
    className={cn('relative block h-[8px] w-[8px] flex-none', running && 'ns-blink')}
  >
    <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-current" />
    {!open ? <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-current" /> : null}
  </span>
);

export const ToolCallRow: React.FC<ToolCallRowProps> = ({
  title,
  summary,
  icon,
  tone,
  state = 'ok',
  meta,
  children,
  selected = false,
  footer,
  onOpenChange,
  className,
}) => {
  const [open, setOpen] = React.useState(false);
  // Computed outside the updater on purpose: React invokes an updater twice in
  // development, and a callback that fires twice is a request that fires twice.
  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };
  const expandable = children !== undefined && children !== null && children !== false;
  const failed = state === 'failed';
  const id = React.useId();

  const head = (
    <span className="grid min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
      <span
        className="flex h-[14px] w-[14px] flex-none items-center justify-center"
        style={failed ? undefined : { color: tone }}
      >
        {icon}
      </span>
      <span
        className="flex-none text-[12px] font-medium"
        style={failed ? undefined : { color: tone }}
      >
        {title}
      </span>
      {summary ? (
        <span className="flex min-w-0 items-baseline gap-2">
          <span aria-hidden className="flex-none text-muted-foreground/45">·</span>
          <span
            className={cn(
              'min-w-0 truncate font-mono text-[11.5px]',
              failed ? 'text-[var(--ns-critical)]' : 'text-muted-foreground',
            )}
          >
            {summary}
          </span>
        </span>
      ) : (
        <span />
      )}
    </span>
  );

  return (
    <div
      className={cn(
        'border-l pl-3',
        failed ? 'border-l-2 border-l-destructive' : 'border-l-border',
        selected && 'bg-foreground/[0.06]',
        className,
      )}
      data-state={state}
    >
      {expandable ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={`toolcall-${id}`}
          className="flex w-full items-center gap-3 py-1.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {head}
          {meta ? (
            <span className="flex-none font-mono text-[10px] text-muted-foreground/70">{meta}</span>
          ) : null}
          <Mark open={open} running={state === 'running'} />
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 py-1.5">
          {head}
          {meta ? (
            <span className="flex-none font-mono text-[10px] text-muted-foreground/70">{meta}</span>
          ) : null}
        </div>
      )}

      {expandable && open ? (
        <div id={`toolcall-${id}`} className="flex flex-col items-start gap-2 pb-3 pl-6 pr-2">
          {children}
          {footer}
        </div>
      ) : null}
    </div>
  );
};

ToolCallRow.displayName = 'ToolCallRow';
