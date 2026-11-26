import * as React from 'react';

import { cn } from '../cn';

/**
 * A list of things that open — a FAQ, a set of caveats, a run's collapsed
 * detail rows.
 *
 * It is here rather than in a page because "a row you can open" is a shape the
 * system has, not a thing one marketing band needed. The old landing page had
 * its own, built out of two lucide chevrons and a `slide-in-from-top` keyframe,
 * and the next surface that wanted one would have built a second.
 *
 * ── THE MARK IS DRAWN, NOT AN ICON ──────────────────────────────────────
 * A plus that loses its upright is a minus, and both are one and two bars in a
 * square. Bringing in a chevron would mean bringing in an icon set's idea of a
 * curve, and this system draws its own marks — every one of them square, every
 * one built from cells. Two spans cost less than the import did.
 *
 * ── AND IT DOES NOT SLIDE ───────────────────────────────────────────────
 * The row is open or it is closed. Nothing in this brand eases between two
 * states except the Resolve, and a FAQ answer is not the Resolve; a height
 * transition here would be the one place in the system where something grows.
 * The discipline is the look.
 *
 * ── NO SIGNAL YELLOW ────────────────────────────────────────────────────
 * Deliberately, and it is worth writing down because an open row is exactly the
 * kind of thing that attracts an accent. Signal means live, or the single
 * primary action on the screen. A row the reader happens to have opened is
 * neither, so the open state is said in bone — brighter type and a rule down
 * the left of the answer — which is the alpha ladder doing the job it is for.
 */

export interface DisclosureListItem {
  /** Stable id — used for the open state and to tie the button to its panel. */
  id: string;
  /** The line that is always visible. */
  summary: React.ReactNode;
  /** What opening it reveals. */
  detail: React.ReactNode;
}

/**
 * How much room a row takes.
 *
 * `comfortable` is a page of questions someone is reading one at a time.
 * `compact` is a transcript: dozens of rows, most of them never opened, where
 * the reader is scanning past them to the message underneath. Same row, same
 * marker, same open state — a second component would only have differed here.
 */
export type DisclosureDensity = 'comfortable' | 'compact';

export interface DisclosureListProps {
  items: DisclosureListItem[];
  /**
   * `single` closes the open row when another opens — the right default for a
   * FAQ, where a reader is answering one question at a time and a page that
   * grows under them as they click is disorienting. `multiple` keeps every row
   * the reader opened, for lists that are read as a set.
   */
  mode?: 'single' | 'multiple';
  /** Which row starts open. A FAQ usually wants its first question answered. */
  defaultOpenId?: string;
  /**
   * Heading level for each summary. A FAQ under an `h2` wants `3`; the default
   * suits that. Passing `0` renders no heading, for lists that are not
   * navigational landmarks.
   */
  headingLevel?: 0 | 2 | 3 | 4;
  density?: DisclosureDensity;
  /** Drops the outer rules, for a row set already inside a seamed column. */
  seamless?: boolean;
  className?: string;
}

const ROW: Record<DisclosureDensity, string> = {
  comfortable: 'py-5 font-sans text-base font-medium leading-snug',
  compact: 'py-1.5 font-sans text-[12px] leading-snug',
};

const DETAIL: Record<DisclosureDensity, string> = {
  comfortable: 'pb-6 pl-5 text-[15px] leading-relaxed',
  compact: 'pb-3 pl-4 text-[12px] leading-relaxed',
};

const MARKER_GAP: Record<DisclosureDensity, string> = {
  comfortable: 'ml-6',
  compact: 'ml-3',
};

const Marker: React.FC<{ open: boolean; density: DisclosureDensity }> = ({ open, density }) => (
  <span aria-hidden className={cn('relative block h-[9px] w-[9px] flex-none', MARKER_GAP[density])}>
    <span className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-current" />
    {!open ? (
      <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-current" />
    ) : null}
  </span>
);

export const DisclosureList: React.FC<DisclosureListProps> = ({
  items,
  mode = 'single',
  defaultOpenId,
  headingLevel = 3,
  density = 'comfortable',
  seamless = false,
  className,
}) => {
  const [open, setOpen] = React.useState<string[]>(defaultOpenId ? [defaultOpenId] : []);

  const toggle = (id: string) =>
    setOpen((current) => {
      if (current.includes(id)) return current.filter((openId) => openId !== id);
      return mode === 'single' ? [id] : [...current, id];
    });

  const Heading = (headingLevel === 0 ? 'div' : (`h${headingLevel}` as const)) as 'div';

  return (
    <div className={cn(!seamless && 'border-t border-border', className)}>
      {items.map((item) => {
        const isOpen = open.includes(item.id);
        return (
          <div key={item.id} className={cn(!seamless && 'border-b border-border')}>
            <Heading className="m-0">
              <button
                type="button"
                onClick={() => toggle(item.id)}
                aria-expanded={isOpen}
                aria-controls={`disclosure-${item.id}`}
                className={cn(
                  'flex w-full items-center justify-between gap-4 text-left transition-colors',
                  ROW[density],
                  'focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  isOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{item.summary}</span>
                <Marker open={isOpen} density={density} />
              </button>
            </Heading>

            {/* Unmounted when closed rather than hidden. A FAQ's answers are
                content a crawler should find, but every one of them is also
                inside a <button>'s panel that has a real `aria-expanded` on it,
                and the JSON-LD carries the full text for search regardless —
                so there is nothing to gain from keeping five closed answers in
                the accessibility tree. */}
            {isOpen ? (
              <div
                id={`disclosure-${item.id}`}
                className={cn('border-l border-border text-muted-foreground', DETAIL[density])}
              >
                {item.detail}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

DisclosureList.displayName = 'DisclosureList';
