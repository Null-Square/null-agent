/**
 * The theme switch, as a scan across the page.
 *
 * Ported from `brand-system.html`, which states the reasoning better than a
 * summary could:
 *
 * > The page cannot repaint itself gradually — a theme lands in one frame. So
 * > the board does it instead: a full-screen lattice fills with the incoming
 * > ground on a diagonal front, the theme is committed while the screen is
 * > covered, and the same front clears the cells away again. It is the
 * > Resolve, at page scale, doing something useful.
 *
 * That is the whole argument for it. A CSS colour transition on every element
 * cannot work: half the app's surfaces are painted by tokens that swap
 * instantly, so a cross-fade produces a smear of intermediate colours that
 * belong to neither theme. A cover-commit-reveal has no intermediate state —
 * every cell is one ground or the other, which is the same rule the icons and
 * the live mark follow.
 *
 * The front is one cell wide and it is the only yellow in the move.
 *
 * It never blocks the click: `commit` fires the moment the screen is covered,
 * about half a second in, and the reveal happens over the already-switched
 * page.
 */

const CELL = 16;
const COVER_FRAMES = 30;
const REVEAL_FRAMES = 30;
const SIGNAL = '245, 209, 58';

/** Grounds the wipe paints. Not tokens: the canvas draws before they swap. */
const GROUND = { light: '#E8E8ED', dark: '#000000' } as const;

/** Deterministic jitter, so the diagonal reads as a front and not a ruled line. */
const hash = (n: number): number => {
  let x = (n ^ 61) ^ (n >>> 16);
  x = (x + (x << 3)) | 0;
  x ^= x >>> 4;
  x = Math.imul(x, 0x27d4eb2d);
  x ^= x >>> 15;
  return ((x >>> 0) % 1000) / 1000;
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run the wipe, committing the theme change while the screen is covered.
 *
 * `commit` is called exactly once. If the wipe cannot run — no DOM, reduced
 * motion — it is called immediately, so the caller never has to branch.
 */
export function themeWipe(next: 'light' | 'dark', commit: () => void): void {
  if (typeof document === 'undefined' || !document.body || prefersReducedMotion()) {
    commit();
    return;
  }

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100vw;height:100vh;z-index:200;pointer-events:none';
  document.body.appendChild(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    commit();
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const span = cols + rows;
  const ground = GROUND[next];

  // A cell's place along the diagonal, jittered.
  const at = (x: number, y: number) => x + y + hash(x * 31 + y * 17) * 3.5;

  let frame = 0;
  let committed = false;

  const draw = () => {
    frame += 1;
    const covering = frame <= COVER_FRAMES;
    const progress = covering
      ? frame / COVER_FRAMES
      : (frame - COVER_FRAMES) / REVEAL_FRAMES;

    // Commit under cover: the reveal then uncovers the new theme.
    if (!covering && !committed) {
      committed = true;
      commit();
    }

    const front = progress * (span + 10) - 5;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = ground;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const d = at(x, y);
        const lit = covering ? d < front : d > front;
        if (lit) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // The front itself, one cell wide — the only yellow in the move.
    ctx.fillStyle = `rgba(${SIGNAL},0.85)`;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        if (Math.abs(at(x, y) - front) > 1.1) continue;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    if (frame < COVER_FRAMES + REVEAL_FRAMES) {
      requestAnimationFrame(draw);
      return;
    }

    canvas.remove();
    // Belt and braces: a torn-down frame loop must never leave the theme unset.
    if (!committed) {
      committed = true;
      commit();
    }
  };

  requestAnimationFrame(draw);
}

/** How long the whole move takes, for callers that need to debounce a toggle. */
export const THEME_WIPE_MS = Math.round(((COVER_FRAMES + REVEAL_FRAMES) / 60) * 1000);
