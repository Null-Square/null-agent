import React from 'react';

import { cn } from './cn';

/**
 * StatBreakdownCard — a total plus its category breakdown, as flat bars.
 *
 * Distinct from `ListMetrics` (four bare figures): this shows one big number
 * and a list of the categories that sum to it, each a mono label, a flat
 * proportional bar, and a tabular count. Ported from a brand-system
 * exploration of re-skinning rounded KPI tiles (status codes, methods,
 * response times) into the flat hairline-card language.
 *
 * Severity colour is the product-frame exception (Chapter III) — `highlight`
 * only ever points at the severity ramp or 'none' for a neutral bone bar.
 */

export type StatBreakdownHighlight = 'critical' | 'high' | 'medium' | 'low' | 'success' | 'none';

export interface StatBreakdownItem {
  label: string;
  count: number;
  highlight?: StatBreakdownHighlight;
}

export interface StatBreakdownCardProps {
  title: string;
  total: number;
  totalLabel?: string;
  items: StatBreakdownItem[];
  className?: string;
}

const BAR_CLASSES: Record<StatBreakdownHighlight, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  success: 'bg-success',
  none: 'bg-muted-foreground',
};

export const StatBreakdownCard: React.FC<StatBreakdownCardProps> = ({
  title,
  total,
  totalLabel = 'Total',
  items,
  className,
}) => (
  <div className={cn('flex min-h-[176px] min-w-0 flex-col border border-border bg-background p-6', className)}>
    <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">{title}</span>

    <div className="mt-5">
      <div className="font-mono text-[3rem] font-extrabold leading-none tracking-[-0.05em] tabular-nums text-foreground">
        {total}
      </div>
      <div className="mt-2.5 text-sm text-muted-foreground">{totalLabel}</div>
    </div>

    <div className="mt-8 flex flex-col gap-3.5">
      {items.map((item) => {
        const percent = total > 0 ? (item.count / total) * 100 : 0;
        const barClass = BAR_CLASSES[item.highlight ?? 'none'];
        return (
          <div key={item.label} className="grid grid-cols-[64px_1fr_40px] items-center gap-3.5">
            <span className="truncate font-mono text-[10.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
              {item.label}
            </span>
            <div className="h-3 w-full bg-surface-1">
              <div className={cn('h-full', barClass)} style={{ width: `${percent}%` }} />
            </div>
            <span className="text-right font-mono text-[13px] font-bold tabular-nums text-foreground">
              {item.count}
            </span>
          </div>
        );
      })}
    </div>
  </div>
);
