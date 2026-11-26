import React from 'react';

import { cn } from '../cn';

/**
 * FigureLine — a record's totals on one line, above the thing they total.
 *
 * `FactGrid` is the right shape when the facts *are* the page: a dozen fields
 * with room to breathe, each on its own hairline. It is the wrong shape above a
 * stream. Six facts at grid density is two rows and a hundred vertical pixels,
 * spent restating what the reader is about to scroll — and on a page whose one
 * job is to show as many rows as the window can hold, a hundred pixels is
 * roughly three rows of the actual answer.
 *
 * So the same facts set as one mono line: label dim, value bright, no rules and
 * no cells. It costs about a fifth of the height and says exactly as much.
 *
 * ── LABEL AND VALUE, NOT A JOINED STRING ────────────────────────────────
 * `ListMeta` pre-joins its facts with a middot, which is right for a row's
 * metadata where every fact is self-describing (`SOC 2`, `us-east-1`). Totals
 * are not self-describing — `12 · 96 · 2` is a lottery ticket — so each figure
 * keeps its label, and the label/value pairing does the separating that a
 * middot would otherwise have to do.
 *
 * Values are **real data, so they are mono and tabular**, per the brand's mono
 * rule. Labels are chrome, and would be sans anywhere else; here they are the
 * same face at a dimmer rung so the line reads as one object rather than two
 * alternating typefaces.
 */

export interface FigureLineItem {
  /** What the figure is. Dim — the number is what the reader is aiming at. */
  label: React.ReactNode;
  value: React.ReactNode;
  /**
   * Shown when `value` is null, undefined or empty.
   *
   * Not defaulted to a zero: an unmeasured total and a total of zero are
   * different facts, and printing `0` states the second one.
   */
  empty?: React.ReactNode;
}

export interface FigureLineProps {
  /** Falsy entries are dropped, so callers can inline conditionals. */
  items: Array<FigureLineItem | null | undefined | false>;
  className?: string;
  'aria-label'?: string;
}

export const FigureLine: React.FC<FigureLineProps> = ({
  items,
  className,
  'aria-label': ariaLabel,
}) => {
  const figures = items.filter((item): item is FigureLineItem => Boolean(item));
  if (figures.length === 0) return null;

  return (
    <dl
      aria-label={ariaLabel}
      className={cn(
        'flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10.5px]',
        className,
      )}
    >
      {figures.map((figure, index) => {
        const absent = figure.value === null || figure.value === undefined || figure.value === '';
        return (
          <div key={index} className="flex items-baseline gap-1.5">
            <dt className="uppercase tracking-[0.12em] text-muted-foreground/60">{figure.label}</dt>
            <dd
              className={cn(
                'tabular-nums',
                absent ? 'text-muted-foreground/70' : 'text-foreground/85',
              )}
            >
              {absent ? (figure.empty ?? '—') : figure.value}
            </dd>
          </div>
        );
      })}
    </dl>
  );
};
