import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * IdentityBand — the thing you are looking at, said once and said loudly.
 *
 * A page that opens straight into a stack of equal panels reads as a form,
 * not as a place. The band fixes that without inventing anything: the brand's
 * own 11×11 glyph at empty-state scale (the icon chapter proves it holds at
 * 44px), the name at display size, the identifier in mono because it is real
 * data, and the page's figures in the KPI order the system already uses —
 * number first, label under it.
 *
 * One hairline frames it, radius 0, no shadow, no wash. The glyph carries the
 * single signal block it was drawn with, so the band needs no other colour and
 * leaves the screen's one yellow moment free for an actual action.
 */

export interface IdentityBandStat {
  label: string;
  value: React.ReactNode;
}

export interface IdentityBandProps {
  /** Brand glyph naming what this is — an organization, a scope, a runner. */
  glyph?: CellIconName;
  name: React.ReactNode;
  /** The identifier or one-line placement, rendered mono. */
  meta?: React.ReactNode;
  /** At most three figures. Beyond that it stops being a headline. */
  stats?: IdentityBandStat[];
  actions?: React.ReactNode;
  className?: string;
}

export const IdentityBand: React.FC<IdentityBandProps> = ({
  glyph,
  name,
  meta,
  stats,
  actions,
  className,
}) => (
  <section
    className={cn(
      // Open at every edge, and one hairline underneath it: the band is the
      // top of a page, not a card sitting on one. The frame it used to draw
      // put a box around the org's own name, which is the last thing on a
      // page that needs one.
      'flex flex-col gap-8 border-b border-border pb-8 lg:flex-row lg:items-center lg:justify-between',
      className,
    )}
  >
    <div className="flex min-w-0 items-center gap-5">
      {/* The icon is drawn on the lattice already — a box around it is a
          second frame for one mark. */}
      {glyph ? <CellIcon name={glyph} size={46} className="flex-none text-foreground/70" /> : null}
      <div className="min-w-0">
        <h2 className="truncate text-[clamp(1.5rem,2.2vw,2rem)] font-extrabold leading-none tracking-[-0.035em] text-foreground">
          {name}
        </h2>
        {meta ? (
          <p className="mt-2.5 truncate font-mono text-sm text-muted-foreground">{meta}</p>
        ) : null}
      </div>
    </div>

    {stats?.length || actions ? (
      <div className="flex flex-wrap items-end gap-8 lg:justify-end">
        {stats?.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <div className="text-[1.75rem] font-extrabold leading-none tracking-[-0.045em] tabular-nums text-foreground">
              {stat.value}
            </div>
            <div className="mt-2 text-sm font-semibold text-muted-foreground">{stat.label}</div>
          </div>
        ))}
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
    ) : null}
  </section>
);
