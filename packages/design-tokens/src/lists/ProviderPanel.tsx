import React from 'react';

import { cn } from '../cn';

/**
 * ProviderPanel — one connected (or connectable) external provider.
 *
 * Main column plus a right action rail, split by a hairline — the same anatomy
 * the brand gives a detail page, at panel scale. It puts the verbs in one
 * predictable place instead of trailing the heading, which is what let the
 * GitHub panel grow three pill-shaped buttons in a row.
 *
 * `facts` is the mono footer: real data, labelled, sitting at the bottom of the
 * main column so every provider reports itself the same way.
 */

export interface ProviderFact {
  label: string;
  value: React.ReactNode;
}

export interface ProviderPanelProps {
  name: string;
  icon?: React.ReactNode;
  /** A StatusPill, or any short state marker. */
  status?: React.ReactNode;
  description?: React.ReactNode;
  facts?: ProviderFact[];
  /** Stacked full-width in the rail; the first one is the primary verb. */
  actions?: React.ReactNode;
  /** Full-width notes below both columns (warnings, install feedback). */
  footer?: React.ReactNode;
  /** Dim the panel — a provider that exists but is not available yet. */
  muted?: boolean;
  className?: string;
}

export const ProviderPanel = React.forwardRef<HTMLDivElement, ProviderPanelProps & { [key: `data-${string}`]: string }>(
  ({ name, icon, status, description, facts, actions, footer, muted = false, className, ...rest }, ref) => (
    <div
      ref={ref}
      {...rest}
      // Open, with one seam under it. A provider is a section of a settings
      // page, not a card floating on one — and the frame was doing no work
      // that the heading and the space between providers were not.
      className={cn('border-b border-border pb-8', muted && 'text-muted-foreground', className)}
    >
      <div className={cn('grid grid-cols-1', actions ? 'lg:grid-cols-[1fr_280px]' : '')}>
        <div
          className={cn(
            'flex flex-col gap-5 py-2',
            actions && 'lg:pr-10',
          )}
        >
          <div className="flex flex-wrap items-center gap-4">
            {icon ? (
              // The glyph stands on its own; a box around it is a second
              // frame for one mark.
              <span className={cn('flex flex-none items-center', muted ? 'text-muted-foreground' : 'text-foreground')}>
                {icon}
              </span>
            ) : null}
            <h3 className={cn('text-[19px] font-bold tracking-tight', muted ? 'text-foreground/70' : 'text-foreground')}>
              {name}
            </h3>
            {status}
          </div>

          {description ? (
            <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}

          {facts && facts.length > 0 ? (
            <dl className="mt-auto flex flex-wrap gap-x-12 gap-y-4 pt-2">
              {facts.map((fact) => (
                <div key={fact.label} className="flex flex-col gap-1.5">
                  <dt className="font-mono text-[10px] font-bold uppercase tracking-[0.09em] text-muted-foreground">
                    {fact.label}
                  </dt>
                  <dd className="font-mono text-[13px] font-bold text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>

        {actions ? (
          <div className="flex flex-col justify-center gap-3 py-2 [&>*]:w-full">{actions}</div>
        ) : null}
      </div>

      {footer ? <div className="mt-6 border-t border-border pt-4">{footer}</div> : null}
    </div>
  ),
);

ProviderPanel.displayName = 'ProviderPanel';
