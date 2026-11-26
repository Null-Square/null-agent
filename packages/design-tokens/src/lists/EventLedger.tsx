import React from 'react';

import { cn } from '../cn';

/**
 * EventLedger — one ordered stream of records, read like a log.
 *
 * `RecordTable` is the one data table: columns, headers, a page of rows you
 * scan. This is the other shape, and it is genuinely different — hundreds to
 * thousands of rows, no pagination, every row the same two things (what kind of
 * event it was, and what it said), and the content given all the width there is
 * because the content is the reason anyone opened the page.
 *
 * Everything a table would have put in a column — duration, tokens, ids — is
 * deliberately not here. It goes in the inspector, which is what selecting a row
 * opens. Squeezing four numeric columns in costs the content half the width and
 * answers a question nobody asked while scanning.
 *
 * The kind sets in mono and is **not a badge**: the brand forbids a border
 * around a word, and the severity ramp belongs to severity. It is the one
 * column that repeats identically on every row, so it carries the trace-kind
 * tint (`--ns-trace-*`) — the tint is what makes the column skimmable instead
 * of something you have to read. A record that failed takes a finding-coloured
 * leading seam, which is how the kit already marks an error field and an error
 * toast, and that seam outranks the tint.
 */

export interface EventLedgerRow {
  id: string;
  /**
   * The record's position in the stream, shown as `#N`.
   *
   * A trace nobody can point at is a trace nobody discusses. Two people looking
   * at the same session need a way to say *which* row, and the record id is a
   * UUID — unusable out loud and unusable in a note. Absent hides the column.
   */
  index?: number;
  /** The record's kind. Machine vocabulary — rendered mono, uppercase, dim. */
  kind: string;
  /** One line. Truncated by CSS; the whole of it belongs in the inspector. */
  content: React.ReactNode;
  /** Pinned to the trailing edge — a status, a duration. Kept short. */
  meta?: React.ReactNode;
  /**
   * Opens a new group above this row when the id differs from the row before.
   *
   * A group is also the unit the reader folds. Everything under one rule
   * disappears together, which is the only way a five-hundred-turn session is
   * navigable at all.
   */
  groupId?: string;
  groupLabel?: React.ReactNode;
  /** Draws the finding-coloured leading seam. For a record that failed. */
  failed?: boolean;
  /**
   * How loudly this row reads.
   *
   * The brand has no second hue to spend on categories — no greys, one signal,
   * and the severity ramp belongs to severity. What it does have is the alpha
   * ladder, and a ladder is a better answer than colour anyway: dimming the
   * plumbing makes the conversation the thing your eye lands on, where five
   * tints would only make five things shout at once.
   */
  emphasis?: 'strong' | 'normal' | 'quiet';
  /**
   * Colour for the kind cell — a `--ns-trace-*` token, nothing else.
   *
   * The ladder answers "how loud"; this answers "what family". They are
   * different questions and a row usually wants both: a tool call is normal
   * weight and tool-tinted, the sandbox event underneath it is quiet and
   * machine-tinted. Absent falls back to the ladder alone.
   */
  tone?: string;
  /** Dimmed rather than removed — outside the focused interval, still in order. */
  dimmed?: boolean;
}

export interface EventLedgerProps {
  rows: EventLedgerRow[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Describes the stream, for assistive technology. */
  label: string;
  /** Viewport height in px. The ledger scrolls inside it; the page does not. */
  height?: number;
  rowHeight?: number;
  groupHeight?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /**
   * Group ids whose rows are folded away. The rule stays; the rows go.
   *
   * Folded before the draw list is built, so the virtual list never has to know
   * a row exists that it must not measure — which is where every fold-plus-
   * virtualisation bug comes from.
   */
  collapsedGroups?: ReadonlySet<string>;
  /** Makes the group rules controls. Without it a rule is a rule. */
  onToggleGroup?: (groupId: string) => void;
  /** Rendered in place of the rows when there are none. */
  empty?: React.ReactNode;
  className?: string;
}

const DEFAULT_ROW_HEIGHT = 30;
const DEFAULT_GROUP_HEIGHT = 30;
const DEFAULT_HEIGHT = 560;
const OVERSCAN = 10;

type Item =
  | { type: 'group'; key: string; id: string; label: React.ReactNode; collapsed: boolean }
  | { type: 'row'; key: string; row: EventLedgerRow };

/**
 * Flatten rows into a draw list, inserting a rule wherever the group changes.
 *
 * Folded groups keep their rule and drop their rows here, before any offset is
 * computed. A virtual list that filters at draw time instead has to reconcile
 * two different row counts and will get it wrong at exactly one scroll position.
 */
export function buildLedgerItems(
  rows: EventLedgerRow[],
  collapsedGroups?: ReadonlySet<string>,
): Item[] {
  const items: Item[] = [];
  let openGroup: string | undefined;
  let folded = false;
  for (const row of rows) {
    if (row.groupId !== undefined && row.groupId !== openGroup) {
      openGroup = row.groupId;
      folded = collapsedGroups?.has(row.groupId) ?? false;
      items.push({
        type: 'group',
        key: `group:${row.groupId}`,
        id: row.groupId,
        label: row.groupLabel ?? row.groupId,
        collapsed: folded,
      });
    }
    if (folded) continue;
    items.push({ type: 'row', key: row.id, row });
  }
  return items;
}

/**
 * Offsets for a two-height virtual list.
 *
 * Rows and group rules are different heights, so a single multiply does not
 * locate a scroll position. The prefix sums are cheap and exact; guessing with
 * one average height is what makes a virtual list drift as you scroll.
 */
export function ledgerOffsets(items: Item[], rowHeight: number, groupHeight: number): number[] {
  const offsets = new Array<number>(items.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < items.length; index += 1) {
    offsets[index + 1] = offsets[index]! + (items[index]!.type === 'group' ? groupHeight : rowHeight);
  }
  return offsets;
}

/**
 * The item containing `scrollTop`, by binary search over the prefix sums.
 *
 * The comparison is strictly greater on purpose. An item that *ends* exactly at
 * the scroll position is not on screen, so `>=` puts the boundary case one row
 * too early — invisible at a glance, and the reason a virtual list quietly
 * renders a row above the viewport at every group rule.
 */
export function ledgerIndexAt(offsets: number[], scrollTop: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid]! <= scrollTop) low = mid + 1;
    else high = mid;
  }
  return Math.max(0, low - 1);
}

const cssId = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '-');

const KIND_EMPHASIS: Record<NonNullable<EventLedgerRow['emphasis']>, string> = {
  strong: 'text-foreground/70',
  normal: 'text-muted-foreground',
  quiet: 'text-muted-foreground/55',
};

const CONTENT_EMPHASIS: Record<NonNullable<EventLedgerRow['emphasis']>, string> = {
  strong: 'text-foreground',
  normal: 'text-foreground/80',
  quiet: 'text-muted-foreground',
};

export const EventLedger: React.FC<EventLedgerProps> = ({
  rows,
  selectedId = null,
  onSelect,
  label,
  height = DEFAULT_HEIGHT,
  rowHeight = DEFAULT_ROW_HEIGHT,
  groupHeight = DEFAULT_GROUP_HEIGHT,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  collapsedGroups,
  onToggleGroup,
  empty,
  className,
}) => {
  const viewport = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);

  const items = React.useMemo(
    () => buildLedgerItems(rows, collapsedGroups),
    [rows, collapsedGroups],
  );
  const offsets = React.useMemo(
    () => ledgerOffsets(items, rowHeight, groupHeight),
    [items, rowHeight, groupHeight],
  );
  const total = offsets[offsets.length - 1] ?? 0;

  const start = Math.max(0, ledgerIndexAt(offsets, scrollTop) - OVERSCAN);
  const end = Math.min(items.length, ledgerIndexAt(offsets, scrollTop + height) + OVERSCAN + 1);
  const visible = items.slice(start, end);

  const rowIndexById = React.useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.type === 'row') map.set(item.row.id, index);
    });
    return map;
  }, [items]);

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    // Only what is on screen. Arrowing into a folded group would select a row
    // the reader cannot see and scroll to a position that does not exist.
    const rowIds = items.flatMap((item) => (item.type === 'row' ? [item.row.id] : []));
    if (rowIds.length === 0) return;
    const current = selectedId ? rowIds.indexOf(selectedId) : -1;
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? rowIds.length - 1
        : Math.min(rowIds.length - 1, Math.max(0, current + (event.key === 'ArrowDown' ? 1 : -1)));
    const id = rowIds[next];
    if (!id) return;
    onSelect?.(id);
    const itemIndex = rowIndexById.get(id);
    const target = viewport.current;
    if (itemIndex !== undefined && target && typeof target.scrollTo === 'function') {
      const top = offsets[itemIndex] ?? 0;
      if (top < scrollTop) target.scrollTo({ top });
      else if (top + rowHeight > scrollTop + height) {
        target.scrollTo({ top: top + rowHeight - height });
      }
    }
  };

  if (rows.length === 0) {
    return <div className={className}>{empty ?? null}</div>;
  }

  return (
    <div
      ref={viewport}
      role="listbox"
      aria-label={label}
      aria-activedescendant={selectedId ? `ledger-${cssId(selectedId)}` : undefined}
      tabIndex={0}
      onKeyDown={move}
      onScroll={(event) => {
        const element = event.currentTarget;
        setScrollTop(element.scrollTop);
        if (
          hasMore
          && !loadingMore
          && element.scrollTop + element.clientHeight >= element.scrollHeight - rowHeight * 6
        ) {
          onLoadMore?.();
        }
      }}
      className={cn(
        'overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2',
        className,
      )}
      style={{ height }}
    >
      <div style={{ height: total, position: 'relative' }}>
        {visible.map((item, index) => {
          const top = offsets[start + index] ?? 0;
          if (item.type === 'group') {
            const rule = (
              <>
                {onToggleGroup ? (
                  <span aria-hidden className="mr-2 text-muted-foreground/60">
                    {item.collapsed ? '+' : '−'}
                  </span>
                ) : null}
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {item.label}
                </span>
              </>
            );
            const shape = 'absolute inset-x-0 flex items-end border-b border-border-strong pb-1 text-left';
            return onToggleGroup ? (
              <button
                key={item.key}
                type="button"
                aria-expanded={!item.collapsed}
                onClick={() => onToggleGroup(item.id)}
                className={cn(shape, 'hover:text-foreground')}
                style={{ top, height: groupHeight }}
              >
                {rule}
              </button>
            ) : (
              <div
                key={item.key}
                aria-hidden
                className={shape}
                style={{ top, height: groupHeight }}
              >
                {rule}
              </div>
            );
          }
          const { row } = item;
          const selected = selectedId === row.id;
          return (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={selected}
              id={`ledger-${cssId(row.id)}`}
              onClick={() => onSelect?.(row.id)}
              style={{ top, height: rowHeight }}
              className={cn(
                'absolute inset-x-0 grid items-center gap-3 pl-3 pr-3 text-left',
                // The trailing lane is a fixed width, not `auto`, so durations
                // and token counts form a column you can read down instead of a
                // ragged right edge that has to be read row by row. It is one
                // lane and not the reference's four: four numeric columns cost
                // the content 320px, and the content is why the page is open.
                row.index === undefined
                  ? 'grid-cols-[76px_minmax(0,1fr)_132px]'
                  : 'grid-cols-[44px_76px_minmax(0,1fr)_132px]',
                // The turn rule runs continuously down the left of its rows, so a
                // turn reads as one block without boxing it.
                'border-l border-border',
                selected ? 'bg-foreground/[0.09]' : 'hover:bg-foreground/[0.035]',
                row.failed && 'border-l-2 border-l-destructive',
                row.dimmed && !selected && 'opacity-40',
              )}
            >
              {row.index === undefined ? null : (
                <span className="truncate font-mono text-[10px] text-muted-foreground/45">
                  {`#${row.index}`}
                </span>
              )}
              <span
                className={cn(
                  'truncate font-mono text-[10px] uppercase tracking-[0.1em]',
                  row.tone === undefined && KIND_EMPHASIS[row.emphasis ?? 'normal'],
                )}
                style={row.tone === undefined ? undefined : { color: row.tone }}
              >
                {row.kind}
              </span>
              <span
                className={cn(
                  'min-w-0 truncate text-[12px]',
                  CONTENT_EMPHASIS[row.emphasis ?? 'normal'],
                  row.emphasis === 'strong' && 'font-medium',
                )}
              >
                {row.content}
              </span>
              <span className="truncate text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                {row.meta}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
