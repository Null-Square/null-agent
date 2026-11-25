import React from 'react';

import { cn } from '../cn';

/**
 * ListPageShell — the frame every list page sits in.
 *
 * Brand system, Chapter III, first law: "One page shell — content to 1600px."
 * The title, the optional single headline figure, and the page's own actions.
 * No radial washes, no grid overlay: the ground is already black, and a healthy
 * board is mostly black.
 *
 * `metric` is the one number the page is allowed to shout — mono and tabular,
 * because it is real data.
 */

// `title` is the page heading, not the DOM tooltip attribute it would otherwise
// collide with — so the native one is omitted rather than narrowed to a string.
export interface ListPageShellProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  metric?: { label: string; value: React.ReactNode };
  actions?: React.ReactNode;
  /**
   * The return affordance, above the heading — same slot and same name as
   * `DetailPageShell`, so a list that sits under something else and a detail
   * page get back the same way. Usually a `DetailBackLink`.
   */
  backLink?: React.ReactNode;
  children: React.ReactNode;
}

export const ListPageShell: React.FC<ListPageShellProps> = ({
  title,
  subtitle,
  metric,
  actions,
  backLink,
  children,
  className,
  ...rest
}) => (
  <div className="min-h-screen bg-background pb-[100px] font-sans text-foreground selection:bg-primary selection:text-primary-foreground">
    <div className={cn('mx-auto max-w-[1600px] p-4 pt-8 lg:p-10 lg:pt-16', className)} {...rest}>
      {backLink ? <div className="mb-8">{backLink}</div> : null}

      <div className="mb-8 flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[clamp(1.7rem,2.5vw,2.35rem)] font-extrabold tracking-[-0.03em] text-foreground">
            {title}
          </h1>
          {subtitle ? <p className="mt-2 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>

        {metric || actions ? (
          <div className="flex items-end gap-8">
            {actions}
            {/* Same order as the brand doc's KPI (`.kpi .n` / `.kpi .l`): the
                figure leads, the label sits under it in sans. */}
            {metric ? (
              <div className="hidden text-right sm:block">
                <div className="text-[2rem] font-extrabold leading-none tracking-[-0.045em] tabular-nums text-foreground">
                  {metric.value}
                </div>
                <div className="mt-2.5 text-sm font-semibold text-muted-foreground">{metric.label}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {children}
    </div>
  </div>
);
