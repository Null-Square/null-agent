import React from 'react';

import { cn } from '../cn';

/**
 * CellField — the brand's lattice, animated.
 *
 * Two moments need a picture rather than a sentence: the one where something
 * good just happened, and the one where the customer is waiting with nothing
 * to look at. Both get the same object, because the system has one visual
 * idea and a second effect invented for each occasion is how a brand stops
 * being one.
 *
 * `burst` radiates out from the centre once and settles — the mark throwing a
 * shockwave. `sweep` runs a diagonal band across the field forever, for a wait
 * with no measurable end.
 *
 * ── WHY THIS IS NOT A SPINNER ───────────────────────────────────────────
 * Nothing in this system spins, and no cell ever fades: the delay is per-cell
 * and the timing function is `steps(1)`, so what moves is WHICH cell is lit,
 * never a rotation and never an opacity ramp. It is the same rule as the icon
 * set and `CellMeter` — the structure holds still, the signal cell travels.
 */

export type CellFieldMode = 'burst' | 'sweep';

export interface CellFieldProps {
  mode: CellFieldMode;
  /** Cells per side. Odd numbers keep the mark centred. */
  size?: number;
  /** Edge of one cell, in px. */
  cell?: number;
  className?: string;
}

/** Half-width of the solid square the burst radiates from. */
const MARK_RADIUS = 1;

export const CellField: React.FC<CellFieldProps> = ({
  mode,
  size = 13,
  cell = 9,
  className,
}) => {
  const centre = (size - 1) / 2;

  const cells = React.useMemo(() => {
    const out: Array<{ key: string; mark: boolean; delay: number }> = [];
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        /* Chebyshev distance, not Euclidean: it rings the centre in SQUARES,
           which is the only shape this brand draws. */
        const ring = Math.max(Math.abs(x - centre), Math.abs(y - centre));
        out.push({
          key: `${x}-${y}`,
          mark: mode === 'burst' && ring <= MARK_RADIUS,
          /* Burst orders by ring, so the edge travels outward. Sweep orders by
             the anti-diagonal, so a band crosses corner to corner.
             The sweep's stagger is deliberately tighter than the burst's: the
             lit window is fixed in the keyframe, so a smaller step per cell is
             what puts several diagonals inside it at once and turns a dotted
             staircase into a bar. And it does NOT wrap with a modulo — that
             put a second band on screen chasing the first. */
          delay: mode === 'burst' ? ring * 62 : (x + y) * 52,
        });
      }
    }
    return out;
  }, [mode, size, centre]);

  return (
    <div
      aria-hidden
      className={cn('grid', className)}
      style={{
        gridTemplateColumns: `repeat(${size}, ${cell}px)`,
        gap: 3,
      }}
    >
      {cells.map(({ key, mark, delay }) => (
        <span
          key={key}
          className={mark ? 'ns-cell-mark' : mode === 'burst' ? 'ns-cell-burst' : 'ns-cell-sweep'}
          style={{
            width: cell,
            height: cell,
            ...(mark ? {} : { ['--ns-cell-delay' as string]: `${delay}ms` }),
          }}
        />
      ))}
    </div>
  );
};
