import type React from 'react';

import { CellIcon, type CellIconName } from '@null-ai/design-tokens/ui';

/**
 * DashboardGate — the page, when the page cannot be the page yet.
 *
 * Three situations produce a dashboard with nothing on it: no domain, an
 * unverified domain, and a verified domain whose first assessment is still
 * running. A board of eight empty widgets is the wrong answer to all three —
 * it shows someone eight broken things and no way to fix any of them — so the
 * page becomes the one thing that is true, at the size of the page.
 *
 * They share this shape so the sequence reads as one story told in three
 * frames: same icon size, same kicker, same measure, same verb position. Only
 * the words and the mark change.
 *
 * The `live` kicker blinks, and nothing else on the page moves. That is the
 * brand's one animation and it means exactly one thing — something is
 * happening right now — so it belongs to the "already running" frame and to no
 * other.
 */

export interface DashboardGateProps {
  icon: CellIconName;
  /** Mono kicker above the headline. */
  kicker: string;
  /** `live` blinks the kicker mark; `attention` is warning-coloured. */
  tone?: 'attention' | 'live';
  /** The headline. Pass a mono node when it is real data, like a hostname. */
  headline: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * A gate that replaces the whole page owns the `h1`; one rendered inside the
   * shell sits under the shell's own heading.
   */
  as?: 'h1' | 'h2';
}

export function DashboardGate({
  icon,
  kicker,
  tone = 'attention',
  headline,
  description,
  action,
  footer,
  as: Heading = 'h2',
}: DashboardGateProps) {
  const isLive = tone === 'live';

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col items-center justify-center px-6 py-20">
      <div className="w-full max-w-xl text-center">
        <CellIcon name={icon} size={84} className="mx-auto text-foreground/30" />

        <p
          className={`mt-10 flex items-center justify-center gap-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.2em] ${
            isLive ? 'text-primary' : 'text-warning'
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 ${isLive ? 'ns-live-mark bg-primary' : 'bg-warning'}`}
          />
          {kicker}
        </p>

        <Heading className="mt-6 text-[clamp(1.6rem,4vw,2.4rem)] font-extrabold leading-[1.1] tracking-[-0.03em] text-foreground">
          {headline}
        </Heading>

        <p className="mx-auto mt-7 max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
          {description}
        </p>

        {action ? <div className="mt-10 flex justify-center">{action}</div> : null}
      </div>

      {footer ? <div className="mt-16 w-full max-w-2xl">{footer}</div> : null}
    </div>
  );
}
