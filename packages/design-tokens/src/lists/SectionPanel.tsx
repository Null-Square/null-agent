import React from 'react';

import { cn } from '../cn';

/**
 * SectionPanel — a titled section, open at every edge.
 *
 * The frame for content that is neither a list page nor a dialog: an
 * integration provider, a credential group, a settings section.
 *
 * It used to draw a border on all four sides, which the product kit rules out
 * in as many words: *"A border marks a surface; a seam divides one — never
 * both"*, and *"a seam divides, it never encloses"*. A page of these read as a
 * stack of cards floating on black — the layout this brand replaced — and the
 * enclosing rule was doing no work that the heading and the space around it
 * were not already doing.
 *
 * So there is one hairline: under the header, dividing the title from what it
 * titles. Nothing on the sides, nothing underneath. Sections are told apart by
 * the space between them, which is what space is for.
 *
 * `boxed` restores the old frame for the one case that needs it — a panel
 * sitting *inside* another surface, where there is no page margin to separate
 * it from its neighbour.
 *
 * The header carries a title, an optional line of explanation, and at most one
 * action. `flush` drops body padding for content that manages its own (a
 * `RecordTable`, a split rail).
 */

export interface SectionPanelProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  /** Body content sets its own padding (tables, rails). */
  flush?: boolean;
  /** Keep the enclosing frame. Only for a panel nested inside another surface. */
  boxed?: boolean;
  className?: string;
  bodyClassName?: string;
}

export const SectionPanel: React.FC<SectionPanelProps> = ({
  title,
  description,
  actions,
  children,
  flush = false,
  boxed = false,
  className,
  bodyClassName,
}) => (
  <section className={cn(boxed && 'border border-border', className)}>
    <div
      className={cn(
        'flex flex-col gap-4 border-b border-border py-5 sm:flex-row sm:items-center sm:justify-between',
        boxed && 'px-6',
      )}
    >
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h3>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-none flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
    {children ? (
      <div className={cn(flush ? '' : 'py-6', boxed && !flush && 'px-6', bodyClassName)}>
        {children}
      </div>
    ) : null}
  </section>
);
