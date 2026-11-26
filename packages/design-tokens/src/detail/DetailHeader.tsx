import React from 'react';
import { cn } from '../cn';

/**
 * DetailHeader — badges, title, subline.
 *
 * The fixed top of every detail main column: severity/lifecycle/score badges,
 * then the one thing you came to read, then the identifiers that place it
 * (asset, endpoint, scope). The subline entries stay separate elements so each
 * can be a link where the data supports one.
 */

export interface DetailHeaderProps {
  /** Severity / status / score badges. */
  badges?: React.ReactNode;
  title: React.ReactNode;
  /** Asset, endpoint, scope — anything that locates this record. */
  subline?: Array<React.ReactNode>;
  /**
   * The heading element. `h1` on a detail page, because the record's name IS
   * the page — and that stays the default, so every app page is unchanged.
   *
   * It is a prop because the marketing site reproduces these surfaces INSIDE a
   * page that already has an `h1`, which shipped three agent pages with two of
   * them. The second was a 100-character SOC 2 control title competing with the
   * page's actual subject. Nothing looked wrong; the outline was.
   */
  as?: 'h1' | 'h2' | 'h3';
  /**
   * The page's verbs, beside the title.
   *
   * Normally a detail page's verbs live in the rail, and this stays empty. A
   * page built on `InspectorSplit` has no rail — the stream owns the screen —
   * so its verbs have nowhere else that is not a second band under the header.
   * They sit on the title's line, where the eye already is.
   */
  actions?: React.ReactNode;
  className?: string;
}

const TITLE = 'text-[clamp(1.6rem,2.4vw,2.15rem)] font-extrabold leading-tight tracking-[-0.03em] text-foreground';

export const DetailHeader: React.FC<DetailHeaderProps> = ({
  badges,
  title,
  subline,
  as: Heading = 'h1',
  actions,
  className,
}) => {
  const items = (subline ?? []).filter(Boolean);

  return (
    <header className={cn('flex flex-col gap-4', className)}>
      {badges ? <div className="flex flex-wrap items-center gap-2.5">{badges}</div> : null}
      {/* The level moves; the type never does. A heading that shrank when it
          was nested would make the same record look less important on the page
          that is arguing for it. */}
      {actions ? (
        // Only wrapped when there is something to sit beside. Sixty pages pass
        // no actions, and a flex row around a lone heading is a layout change
        // they did not ask for.
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <Heading className={cn('min-w-0', TITLE)}>{title}</Heading>
          <div className="flex flex-none items-center gap-2">{actions}</div>
        </div>
      ) : (
        <Heading className={TITLE}>{title}</Heading>
      )}
      {items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          {items.map((item, index) => (
            <span key={index} className="flex items-center gap-3">
              {index > 0 ? <span aria-hidden className="text-muted-foreground/40">·</span> : null}
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
};
