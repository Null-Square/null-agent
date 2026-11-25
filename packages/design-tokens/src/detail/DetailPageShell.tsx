import React from 'react';
import { cn } from '../cn';
import { RailLayout } from './RailLayout';

/**
 * DetailPageShell — the frame every detail page shares.
 *
 * Brand system, Chapter IV ("Four entities, one skeleton"): a return link and
 * the display ID on top, then a main column beside a **360px sticky rail**.
 * Chapter III's sketch said 300 and called the rail a properties list; both
 * were corrected against the real pages — it is 360, and it is a workflow.
 *
 * The rail is `position: sticky` because its verb has to stay reachable while
 * you read down a long finding. On narrow viewports it stacks under the main
 * column rather than shrinking into uselessness.
 */

export interface DetailPageShellProps {
  /** Where the back link goes, e.g. "Findings". Rendered by the consumer. */
  backLink?: React.ReactNode;
  /** Real data — mono, e.g. "FND-7A9". */
  displayId?: React.ReactNode;
  rail?: React.ReactNode;
  /**
   * Drop the trailing space under the page.
   *
   * The default 100px exists so a page's last section is not glued to the fold.
   * A page whose last block already measures itself against the window — a
   * trajectory, a log — does not want it: the space lands *below* the fold and
   * the only thing it adds is a scrollbar with nothing at the end of it.
   */
  flush?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const DetailPageShell: React.FC<DetailPageShellProps> = ({
  backLink,
  displayId,
  rail,
  flush = false,
  children,
  className,
}) => (
  <div
    className={cn(
      'min-h-screen bg-background font-sans text-foreground selection:bg-primary selection:text-primary-foreground',
      flush ? 'pb-0' : 'pb-[100px]',
    )}
  >
    <div
      className={cn(
        'mx-auto max-w-[1600px] p-4 pt-8 lg:p-10 lg:pt-12',
        flush && 'pb-0 lg:pb-0',
        className,
      )}
    >
      {backLink || displayId ? (
        <div className="mb-8 flex items-center justify-between gap-6 border-b border-border/60 pb-5">
          {backLink}
          {displayId ? (
            <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-muted-foreground">
              {displayId}
            </span>
          ) : null}
        </div>
      ) : null}

      <RailLayout rail={rail}>{children}</RailLayout>
    </div>
  </div>
);
