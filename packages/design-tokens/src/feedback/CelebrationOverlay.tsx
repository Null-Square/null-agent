import React from 'react';

import { cn } from '../cn';
import { CellField } from './CellField';

/**
 * CelebrationOverlay — the moment something the customer set up starts paying
 * off, taken over the whole screen instead of whispered in a panel.
 *
 * The scrim is the brand's one permitted blur (the modal scrim), so this reads
 * as the app stopping to tell you something rather than as another box on a
 * busy page. The celebration itself is the mark throwing a shockwave across
 * the lattice — see `CellField` for why that is a wave of square cells and not
 * confetti, a spinning tick or a ring that draws itself.
 *
 * Copy rule: the headline congratulates, the line under it states the fact,
 * and the last line says what happens next WITHOUT the customer having to do
 * anything. If there is nothing to promise, use a smaller component.
 */

export interface CelebrationOverlayProps {
  open: boolean;
  /** e.g. "Congratulations". */
  eyebrow?: string;
  /** The fact, e.g. "Target verified". */
  title: string;
  /** What happens next, on its own, with no action from the customer. */
  description?: React.ReactNode;
  /** Label for the dismiss control. */
  actionLabel?: string;
  onClose: () => void;
  className?: string;
}

export const CelebrationOverlay: React.FC<CelebrationOverlayProps> = ({
  open,
  eyebrow = 'Congratulations',
  title,
  description,
  actionLabel = 'Continue',
  onClose,
  className,
}) => {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn('fixed inset-0 z-[1100] flex items-center justify-center p-4', className)}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/88 backdrop-blur-[14px]" onClick={onClose} />

      <div className="relative flex w-full max-w-[520px] flex-col items-center px-6 py-10 text-center">
        <CellField mode="burst" />

        <p className="mt-9 font-mono text-[11px] font-bold uppercase tracking-[0.3em] text-ns-yellow">
          {eyebrow}
        </p>
        <h2 className="mt-4 text-3xl font-black leading-tight tracking-tight text-white">
          {title}
        </h2>
        {description ? (
          <p className="mt-4 max-w-[42ch] text-sm leading-relaxed text-white/70">{description}</p>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mt-9 min-h-11 min-w-[168px] bg-ns-yellow px-8 text-sm font-black uppercase tracking-wide text-black transition-opacity hover:opacity-90"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
};
