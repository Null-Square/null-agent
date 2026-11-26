import React from 'react';

import { cn } from './cn';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './Sheet';

/**
 * Drawer — the composed panel that comes in from the edge.
 *
 * `Sheet` is the Radix primitive set: root, portal, overlay, content, close.
 * `Modal` is the *composed* centred dialog — a frame, a titled header, one
 * close control — and nothing composed the edge panel, so five surfaces built
 * their own from `fixed inset-0` upward, and every one of them lost something
 * Radix gives away:
 *
 * - **None of the five locked body scroll**, so the page kept scrolling behind
 *   the panel and a reader who scrolled while reading found somewhere else
 *   when they closed it.
 * - **None of them rendered through a portal**, which is why each carried a
 *   hand-picked `z-[170]` or `z-[180]` to climb out of whatever stacking
 *   context its parent happened to make.
 * - **None trapped focus**, so tabbing walked straight out into the page
 *   underneath while the panel still covered it.
 * - Their scrim was a flat `bg-background/70`; `SheetOverlay` — sitting in the
 *   same kit — is the blurred `bg-black/55` the brand budgets for.
 * - In all five, the only `aria-label` in the file was on the scrim. The
 *   visible close glyph was an unlabelled button wrapping an `<X>`, so a
 *   screen reader announced "button", and the one control actually named
 *   "Close" was a full-screen invisible element.
 *
 * Two of the five were `<form>` elements, because the footer submits what the
 * body collects. Pass `onSubmit` and the panel is a form. That is the whole
 * difference between them, so it is one prop and not a second component.
 */

export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** The small label above the title — what kind of thing this is. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** Under the title: an id and its copy button, a status, a timestamp. */
  subtitle?: React.ReactNode;
  /** Header controls belonging to the whole panel — a tail size, a refresh. */
  actions?: React.ReactNode;
  size?: DrawerSize;
  /** Pinned to the bottom edge; the submit verb lives here. */
  footer?: React.ReactNode;
  /** Makes the panel a `<form>`, so a footer submit reaches this body. */
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  /** Holds the panel open while a write is in the air. */
  busy?: boolean;
  children: React.ReactNode;
  className?: string;
}

const SIZE: Record<DrawerSize, string> = {
  sm: 'sm:w-[420px]',
  md: 'sm:w-[520px]',
  lg: 'sm:w-[640px]',
  xl: 'sm:w-[820px]',
};

export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  eyebrow,
  title,
  subtitle,
  actions,
  size = 'lg',
  footer,
  onSubmit,
  busy = false,
  children,
  className,
}) => {
  const body = (
    <>
      <SheetHeader className="flex-shrink-0 space-y-0 border-b border-border px-6 py-4 text-left">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {eyebrow && (
              // Chrome, so it stays sans — mono is for real data.
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {eyebrow}
              </p>
            )}
            <SheetTitle className="truncate text-[15px] font-semibold tracking-tight">
              {title}
            </SheetTitle>
            {subtitle && <SheetDescription asChild>{<div className="mt-1 min-w-0">{subtitle}</div>}</SheetDescription>}
          </div>
          {/* `SheetContent` draws its own close control, top right, already
              carrying an sr-only "Close". Header actions sit clear of it. */}
          {actions && <div className="flex shrink-0 items-center gap-3 pr-8">{actions}</div>}
        </div>
      </SheetHeader>

      <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">{children}</div>

      {footer && (
        <div className="flex flex-shrink-0 items-center justify-end gap-3 border-t border-border px-6 py-4">
          {footer}
        </div>
      )}
    </>
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <SheetContent
        className={cn(
          'flex w-full flex-col gap-0 border-l border-border-strong bg-background p-0 sm:max-w-none',
          SIZE[size],
          className,
        )}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {body}
          </form>
        ) : (
          body
        )}
      </SheetContent>
    </Sheet>
  );
};
