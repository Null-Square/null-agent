import React from 'react';

import { cn } from '../cn';

/**
 * ListNotice — one hairline row when a list needs to say something.
 *
 * The shared replacement for the bespoke "action required" blocks list pages
 * grew: a kicker, one line, and the verb. A signal left edge marks the rows
 * that carry the page's primary action (so that verb is the page's one yellow);
 * neutral is for advisories that don't ask for anything.
 *
 * Not a card, and not a box either. The brand doc draws its own notes as an
 * inset left edge over padding — `.rnote--live`, `.wb-find`, `.toast` are all
 * `box-shadow: inset 3px 0 0 …` with no surrounding rule — because a border on
 * all four sides plus an accent on one breaks the kit's own line: *"A border
 * marks a surface; a seam divides one — never both."*
 *
 * So the edge is the whole treatment. It marks the row and points down the
 * text; nothing encloses it.
 */

export interface ListNoticeProps {
  /** Mono kicker, e.g. "Action required". */
  label?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The verb(s). Keep it to one primary plus at most one secondary. */
  action?: React.ReactNode;
  tone?: 'signal' | 'neutral';
  className?: string;
}

export const ListNotice: React.FC<ListNoticeProps> = ({
  label,
  title,
  description,
  action,
  tone = 'signal',
  className,
}) => (
  <div
    className={cn(
      'flex flex-col gap-5 border-l-2 py-5 pl-6 md:flex-row md:items-center md:justify-between md:gap-10',
      tone === 'signal' ? 'border-l-primary' : 'border-l-foreground/30',
      className,
    )}
  >
    <div className="min-w-0">
      {label ? (
        <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          {label}
        </div>
      ) : null}
      <div className="text-[15px] font-semibold tracking-tight text-foreground">{title}</div>
      {description ? (
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
    {action ? <div className="flex flex-none flex-wrap items-center gap-3">{action}</div> : null}
  </div>
);
