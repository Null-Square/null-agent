import React from 'react';

import { cn } from '../cn';

/**
 * RailLayout — main column plus the action rail.
 *
 * Brand system, Chapter III: "Detail = main column plus a 300px action rail."
 * The arrangement lived inside `DetailPageShell`, which meant only a whole page
 * could have it — so anything narrower than a page (a tab, a section) fell back
 * to a centred `max-w-4xl` column with dead space beside it, which is the one
 * thing the law exists to prevent.
 *
 * Now it is its own piece: the shell composes it, and so can a tab.
 *
 * The rail is 360px and sticks on wide screens, because what it holds —
 * identifiers, the state of the thing, the action you came to take — should
 * stay reachable while the main column scrolls. `sticky={false}` for a rail
 * inside something that scrolls as one block.
 */

export interface RailLayoutProps {
  /** Rail content — usually `DetailRailBlock` / `DetailRailField` children. */
  rail?: React.ReactNode;
  children: React.ReactNode;
  sticky?: boolean;
  /** Drop the rail's own frame when its children bring their own. */
  bare?: boolean;
  className?: string;
}

export const RailLayout: React.FC<RailLayoutProps> = ({
  rail,
  children,
  sticky = true,
  bare = false,
  className,
}) => (
  <div
    className={cn(
      'flex flex-col gap-10',
      rail && 'lg:flex-row lg:items-start lg:gap-14',
      className,
    )}
  >
    <div className="min-w-0 flex-1">{children}</div>
    {rail ? (
      <aside className={cn('w-full flex-none lg:w-[360px]', sticky && 'lg:sticky lg:top-8')}>
        <div className={cn('flex flex-col gap-8', !bare && 'border border-border px-6 py-7')}>
          {rail}
        </div>
      </aside>
    ) : null}
  </div>
);
