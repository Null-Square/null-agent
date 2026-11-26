import React from 'react';

import { cn } from '../cn';
import { CellIcon, type CellIconName } from '../CellIcon';

/**
 * PromptRail — suggested asks, as a drifting rail.
 *
 * A prompt is not a record. Rendered as a vertical list of title-over-subtitle
 * rows it reads exactly like the conversation history beside it, which is what
 * made the chat page confusing: two groups, one form, two different meanings.
 *
 * So the form carries the difference. Each ask is a brand glyph with its label
 * under it, and the strip drifts sideways using the brand's `ns-marquee` — the
 * same motion the logo ticker uses, already pausing on hover and already off
 * under `prefers-reduced-motion`. Drift is not spin.
 *
 * There is no grid: no frame around the strip, no dividers between items. A
 * border would make each ask a card and the strip a table, and it is neither —
 * it is a set of things you could say.
 *
 * The track is rendered twice so the loop has no seam. The duplicate is inert:
 * `aria-hidden`, and its buttons are removed from the tab order.
 */

export interface PromptRailItem {
  key: string;
  /** The glyph names the place the ask is about. */
  icon?: CellIconName;
  label: React.ReactNode;
  onSelect: () => void;
}

export interface PromptRailProps {
  label?: React.ReactNode;
  items: PromptRailItem[];
  /** Seconds for one full pass. Longer reads calmer. */
  durationSeconds?: number;
  className?: string;
}

const PromptButton: React.FC<{ item: PromptRailItem; inert?: boolean }> = ({ item, inert }) => (
  <button
    type="button"
    onClick={inert ? undefined : item.onSelect}
    tabIndex={inert ? -1 : undefined}
    className="group flex w-[124px] flex-none flex-col items-start gap-2 px-3 py-2 text-left"
  >
    <CellIcon
      name={item.icon ?? 'chat'}
      size={22}
      className="text-muted-foreground transition-colors group-hover:text-foreground"
    />
    <span className="text-[12.5px] leading-snug text-muted-foreground transition-colors group-hover:text-foreground">
      {item.label}
    </span>
  </button>
);

export const PromptRail: React.FC<PromptRailProps> = ({
  label,
  items,
  durationSeconds = 60,
  className,
}) => {
  if (items.length === 0) return null;

  return (
    <section className={cn('w-full', className)}>
      {label ? (
        <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          {label}
        </h2>
      ) : null}

      {/* The strip fades out at both edges rather than being cut by a frame, so
          it reads as continuing rather than ending. */}
      <div
        className="relative overflow-hidden"
        style={{
          maskImage: 'linear-gradient(to right, transparent, black 4%, black 96%, transparent)',
          WebkitMaskImage: 'linear-gradient(to right, transparent, black 4%, black 96%, transparent)',
        }}
      >
        <div
          className="animate-marquee flex w-max"
          style={{ animationDuration: `${durationSeconds}s` }}
        >
          <div className="flex" role="group" aria-label={typeof label === 'string' ? label : 'Suggested prompts'}>
            {items.map((item) => (
              <PromptButton key={item.key} item={item} />
            ))}
          </div>
          <div className="flex" aria-hidden>
            {items.map((item) => (
              <PromptButton key={`${item.key}-loop`} item={item} inert />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
