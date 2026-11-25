import React from 'react';

import { CellIcon, type CellIconName } from '../CellIcon';
import { cn } from '../cn';

/**
 * ListMetrics — the in-page dashboard strip.
 *
 * Ported from the brand doc's own dashboard cell (`.dcell` / `.dnum` / `.dlab`
 * in `signal-block.html`), so the measurements are the spec's, not invented:
 * a 3rem display numeral at weight 800 and -0.05em, tabular, with a plain 14px
 * sans label underneath. The number leads; the label explains it.
 *
 * Type note: the numeral is **sans, not mono**. Mono is for data set in a
 * column — a table cell, a CVSS score, a credit count. A headline figure at
 * display scale is the display face, which is what `.dnum` specifies.
 *
 * Two rules carried over from the doc:
 *   - **The quiet cell.** A zero dims to bone-3 rather than shouting in red,
 *     because on this product an empty severity bucket is the win state — "a
 *     healthy board is mostly black, and that is the argument". The doc applies
 *     the same treatment to `38 / 38 controls passing` (`.dcell--quiet`): good
 *     news is quiet, so don't hand `severity` to a figure that means success.
 *   - **Flush, not boxed.** One hairline top and bottom with seams between the
 *     cells — the lattice, not a row of cards floating in space.
 *
 * ── THE ICON IS OPTIONAL, QUIET, AND NEVER YELLOW ───────────────────────
 * `icon` is additive: sixty-odd callers pass none and are unchanged. Where one
 * is given it sits above the figure in the LABEL's tone, not the number's,
 * because the doc's rule for this cell is that the number leads and everything
 * else explains it — an icon at the numeral's weight competes with the one
 * thing the cell exists to say.
 *
 * Its signal cell is suppressed to `currentColor`. Every mark in `CellIcon`
 * carries one yellow cell as part of its identity, which is right in a product
 * nav where the icon IS the object; in a metrics strip the icon is chrome, and
 * four yellow cells beside four figures spend the accent on a label. Signal is
 * live, or the one primary action on the screen.
 */

export type ListMetricSeverity = 'critical' | 'high' | 'medium' | 'low' | 'signal' | 'none';

export interface ListMetricItem {
  label: string;
  value: number | string;
  /** Colours the figure. Spend it only on what should stop someone. */
  severity?: ListMetricSeverity;
  /** Small trailing unit — "%", "m", " / 38". Set at 0.34em, per `.dnum em`. */
  unit?: string;
  /** A cell mark above the figure, in the label's tone. Decorative. */
  icon?: CellIconName;
}

export interface ListMetricsProps {
  /** Optional group kicker, e.g. "Severity exposure". */
  label?: string;
  items: ListMetricItem[];
  className?: string;
}

const SEVERITY_CLASS: Record<ListMetricSeverity, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  signal: 'text-primary',
  none: 'text-foreground',
};

export const ListMetrics: React.FC<ListMetricsProps> = ({ label, items, className }) => (
  <div className={className}>
    {label ? (
      <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{label}</div>
    ) : null}

    <div className="flex flex-col md:flex-row">
      {items.map((item, index) => {
        const isZero = item.value === 0 || item.value === '0';
        return (
          <div
            key={item.label}
            className={cn(
              'flex min-h-[140px] min-w-0 flex-1 flex-col px-6 py-7',
              index !== 0 && 'border-t border-border md:border-l md:border-t-0',
            )}
          >
            {item.icon ? (
              <CellIcon
                name={item.icon}
                size={22}
                signalColor="currentColor"
                className={cn('mb-5', isZero ? 'text-foreground/30' : 'text-muted-foreground')}
              />
            ) : null}

            <div
              className={cn(
                'text-[3rem] font-extrabold leading-none tracking-[-0.05em] tabular-nums',
                isZero ? 'text-foreground/30' : SEVERITY_CLASS[item.severity ?? 'none'],
              )}
            >
              {item.value}
              {item.unit ? (
                <em className="text-[0.34em] font-semibold not-italic tracking-[-0.02em] text-muted-foreground">
                  {item.unit}
                </em>
              ) : null}
            </div>
            <div className={cn('mt-[13px] truncate text-sm', isZero ? 'text-foreground/30' : 'text-muted-foreground')}>
              {item.label}
            </div>
          </div>
        );
      })}
    </div>
  </div>
);
