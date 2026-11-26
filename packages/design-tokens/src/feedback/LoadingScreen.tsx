import React from 'react';

import { cn } from '../cn';
import { FullLogo } from '../FullLogo';

/**
 * LoadingScreen — the boot screen, and the only one in the system.
 *
 * The signature, breathing, over a bar that sweeps, so that every wait for the
 * app to start looks the same.
 *
 * ── WHY THIS EXISTS RATHER THAN ANOTHER `PendingNote` ──
 * `PendingNote` is for waiting *inside* a page you can already see — a panel
 * fetching one number, a button mid-request. It names the act ("Reading your
 * invoices") because you are watching one thing happen in a page that is
 * otherwise there.
 *
 * This is the other case: there is no page yet. Sign-in used to run a sequence
 * of `PendingNote`s whose captions CHANGED as it progressed — "Preparing the
 * console", then "Reading your account" — which reads as several things going
 * wrong rather than one thing loading. A boot screen must be one image that
 * holds still until the app is ready, so `label` is optional here and off by
 * default. If you find yourself wanting to narrate the stages, that is the
 * instinct this component exists to refuse.
 *
 * ── IT CANNOT FLICKER ──
 * `ns-loader-reveal` delays the paint 150ms so fast loads show nothing, and
 * `useMinimumVisible` holds it once painted. Use both; either alone leaves a
 * window where the screen blinks.
 *
 * Changing the brand's loading animation is one edit to `ns-loader-*` in
 * `ui-styles.css`, and every surface changes with it. That is the point.
 */

export interface LoadingScreenProps {
  /**
   * Optional caption under the bar. Leave it off for boot — a word that changes
   * between stages is what made the old sequence feel broken. Worth setting
   * only when the wait is genuinely unusual and needs explaining.
   */
  label?: string;
  /** `page` fills the viewport; `inline` fills its container. */
  variant?: 'page' | 'inline';
  className?: string;
}

export const LoadingScreen: React.FC<LoadingScreenProps> = ({
  label,
  variant = 'page',
  className,
}) => (
  <div
    role="status"
    aria-live="polite"
    aria-label={label ?? 'Loading'}
    className={cn(
      'flex w-full items-center justify-center bg-background',
      variant === 'page' ? 'min-h-screen' : 'min-h-[240px]',
      className,
    )}
  >
    <div className="ns-loader-reveal flex flex-col items-center gap-7">
      {/* Both lockups ship and CSS chooses. The boot screen paints before any
          theme provider has mounted, so it cannot ask React which theme is on
          — and a logo that swaps a frame later is its own kind of flicker. */}
      <FullLogo
        variant="light"
        alt="NullSquare"
        className="ns-loader-ink-light ns-loader-breathe h-7 w-auto select-none md:h-9"
      />
      <FullLogo
        variant="dark"
        alt="NullSquare"
        className="ns-loader-ink-dark ns-loader-breathe h-7 w-auto select-none md:h-9"
      />

      <div className="relative h-[2px] w-44 overflow-hidden bg-border/60">
        <div className="ns-loader-sweep absolute inset-y-0 w-2/5 bg-primary" />
      </div>

      {label ? (
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
          {label}
        </span>
      ) : null}
    </div>
  </div>
);
