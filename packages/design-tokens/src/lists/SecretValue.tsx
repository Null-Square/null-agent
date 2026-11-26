import React from 'react';

import { cn } from '../cn';

/**
 * SecretValue — a stored secret, hidden until asked for.
 *
 * The mask is a row of small squares rather than the usual bullet string: the
 * system has no circles, and a run of solid blocks reads as redaction, which is
 * exactly what it is.
 *
 * It is a real `<button>`, not a click-handling `<span>` — revealing a
 * credential must be reachable from the keyboard, and assistive tech needs to
 * know the state it is in.
 */

export interface SecretValueProps {
  /**
   * Omit when the secret is write-only — stored server-side and never sent to
   * the client. The mask then renders without a reveal affordance, because
   * offering one that cannot work is a lie about what the UI can do.
   */
  value?: string | null;
  /** Names the secret for assistive tech, e.g. "password for ops-admin". */
  label: string;
  maskLength?: number;
  className?: string;
}

const Mask = ({ length }: { length: number }) => (
  <span aria-hidden className="flex items-center gap-[3px] py-1.5">
    {Array.from({ length }).map((_, index) => (
      <i key={index} className="block h-[7px] w-[7px] bg-foreground/35 transition-colors group-hover:bg-foreground/60" />
    ))}
  </span>
);

export const SecretValue: React.FC<SecretValueProps> = ({ value, label, maskLength = 10, className }) => {
  const [revealed, setRevealed] = React.useState(false);

  if (value == null || value === '') {
    return (
      <span className={cn('inline-flex min-w-0 items-center', className)} title={`${label} — stored, hidden`}>
        <span className="sr-only">{label} is stored and hidden</span>
        <Mask length={maskLength} />
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={revealed}
      aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
      onClick={() => setRevealed((previous) => !previous)}
      className={cn(
        'group inline-flex min-w-0 items-center gap-2 text-left transition-colors',
        className,
      )}
    >
      {revealed ? (
        <span className="truncate font-mono text-[13px] text-foreground">{value}</span>
      ) : (
        <Mask length={maskLength} />
      )}
    </button>
  );
};
