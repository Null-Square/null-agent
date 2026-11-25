import React from 'react';
import { cn } from '../cn';

/**
 * DetailSection — one labelled section of a detail tab.
 *
 * A small uppercase label and the prose under it. Three to seven of these per
 * tab, per the skeleton. No card, no box: the label is the structure, which is
 * why a detail page never ends up as a stack of nested panels.
 */

export interface DetailSectionProps {
  label: React.ReactNode;
  /** Right-aligned control for this section (a copy button, a toggle). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export const DetailSection: React.FC<DetailSectionProps> = ({ label, action, children, className }) => (
  <section className={cn('border-t border-border/60 pt-[22px]', className)}>
    <div className="mb-4 flex items-center justify-between gap-4">
      {/* Full bone at 15px/800, with the rule above: this names one of the few
          things the page is made of, and at 11px muted it was smaller and
          dimmer than its own paragraph. It stays a label — uppercase, tracked —
          and never takes yellow, which belongs to the rail's verb. Brand doc
          `.dp-sec`, corrected 2026-08-12. */}
      <h2 className="text-[15px] font-extrabold uppercase tracking-[0.04em] text-foreground">{label}</h2>
      {action}
    </div>
    <div className="text-[15px] leading-relaxed text-foreground/85">{children}</div>
  </section>
);
