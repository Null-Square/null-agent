import React from 'react';
import { cn } from '../cn';

/**
 * DetailBackLink — the return affordance at the top of a detail page.
 *
 * A 1.6px bone arrow with square caps, per the control-glyph rule: chevrons,
 * closes and checks are strokes, not 11×11 CellIcons — the lattice is too
 * coarse below 18px and a CellIcon names a place, while this is an affordance.
 *
 * Router-agnostic: pass `onClick`, or wrap it in whatever link component the
 * app uses via `as`.
 */

export interface DetailBackLinkProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: React.ReactNode;
}

export const DetailBackLink: React.FC<DetailBackLinkProps> = ({ label, className, ...rest }) => (
  <button
    type="button"
    {...rest}
    className={cn(
      'group inline-flex items-center gap-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
      className,
    )}
  >
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="flex-none">
      <path
        d="M13 8 H4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
      />
      <path
        d="M8 4 L4 8 L8 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
    {label}
  </button>
);
