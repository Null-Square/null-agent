import { useEffect, useRef, useState } from 'react';

/**
 * Hold a loading state on screen long enough to be read.
 *
 * ── THE FLASH IS THE BUG ──
 * A loader that appears and vanishes in 80ms is worse than no loader: the eye
 * registers that something happened but not what, and the page reads as
 * glitching rather than working. Sign-in was three of those in a row.
 *
 * Two halves solve it, and both are needed:
 *
 *   `.ns-loader-reveal` delays the paint by 150ms, so a fast load shows nothing
 *   this hook holds the paint for `minMs`, so a slow-ish load is never a blink
 *
 * Together: under ~150ms you see nothing at all; over it, you see a loader that
 * stays put for at least `minMs`. There is no duration that produces a flicker.
 *
 * The cost is deliberate — a load that finishes at 200ms is made to look like
 * it took `minMs`. That is the right trade for chrome that a person watches on
 * every sign-in, and the wrong one for a button, which should use `PendingNote`
 * and no minimum at all.
 */
export const useMinimumVisible = (active: boolean, minMs = 500): boolean => {
  const [held, setHeld] = useState(active);
  /* When it became visible. `null` while hidden — not 0, which is a real
     timestamp and would make the first frame look infinitely old. */
  const shownAt = useRef<number | null>(active ? Date.now() : null);

  useEffect(() => {
    if (active) {
      if (shownAt.current === null) shownAt.current = Date.now();
      setHeld(true);
      return;
    }

    if (shownAt.current === null) {
      setHeld(false);
      return;
    }

    const remaining = minMs - (Date.now() - shownAt.current);
    if (remaining <= 0) {
      shownAt.current = null;
      setHeld(false);
      return;
    }

    const timer = setTimeout(() => {
      shownAt.current = null;
      setHeld(false);
    }, remaining);
    return () => clearTimeout(timer);
  }, [active, minMs]);

  return held;
};
