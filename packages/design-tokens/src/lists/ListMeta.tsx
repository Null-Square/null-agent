import React from 'react';

import { cn } from '../cn';

/**
 * ListMeta — the quiet mono fact line under a row title.
 *
 * The shared replacement for the chip walls list rows kept growing: a control's
 * id and framework metadata, an asset's profile facts, an automation's scope and
 * trigger. Bordered, tinted chips turn every row into a colour field and fight
 * the severity stripe, which is the one thing on a row allowed to shout.
 *
 * Each fact stays its **own element** rather than a pre-joined string, so it can
 * be read, styled and asserted individually — a joined string would also break
 * `getByText` for a single fact.
 */

export interface ListMetaProps {
  /** Falsy entries are dropped, so callers can inline conditionals. */
  items: Array<React.ReactNode>;
  className?: string;
}

export const ListMeta: React.FC<ListMetaProps> = ({ items, className }) => {
  const facts = items.filter(Boolean);
  if (facts.length === 0) return null;

  return (
    <span
      className={cn(
        'flex flex-wrap items-center gap-x-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground',
        className,
      )}
    >
      {facts.map((fact, index) => (
        <span key={index} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden className="text-muted-foreground/40">·</span> : null}
          <span>{fact}</span>
        </span>
      ))}
    </span>
  );
};
