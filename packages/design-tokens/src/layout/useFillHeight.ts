import React from 'react';

/**
 * How tall a region has to be to reach the bottom of the window.
 *
 * A log is not a section of a page — it is the page. Giving one a fixed height
 * (`height={620}`) inside a document that also scrolls produces the worst of
 * both: a short window onto thousands of rows, a second scrollbar next to the
 * first, and a band of dead background under it on any screen taller than the
 * guess. The guess is also never right twice, because what sits above the
 * region differs per page and per state.
 *
 * So it is measured, once the layout above it has settled.
 *
 * ── WHY THE DOCUMENT OFFSET, NOT THE VIEWPORT OFFSET ──────────────────────
 * The obvious formula is `innerHeight - rect.top`, and it oscillates. As the
 * page scrolls, `rect.top` falls, so the region grows, so the document grows,
 * so there is more to scroll — a feedback loop that reads as a page which will
 * not stop scrolling. Adding `scrollY` back gives the distance from the top of
 * the *document*, which does not move when the reader does, so the answer is
 * stable and the region simply stops where the first screenful ends.
 *
 * ── WHY IT HANDS BACK A REF INSTEAD OF TAKING ONE ─────────────────────────
 * A region like this is usually behind a loading state, so the node it has to
 * measure does not exist on the render that starts the hook. A `RefObject`
 * cannot say when it is filled — React does not re-render for that — so the
 * effect would run once against `null` and the region would keep its floor
 * height for the life of the page. A callback ref backed by state is what
 * actually notices the element arriving.
 */

export interface FillHeightOptions {
  /** Floor. A window too short for the sum still leaves a usable region. */
  min?: number;
  /** Space left under the region, so it does not sit flush on the edge. */
  gutter?: number;
}

export interface FillHeight {
  /** Put this on the region whose height you want. */
  ref: (node: HTMLElement | null) => void;
  height: number;
}

const DEFAULT_MIN = 320;
const DEFAULT_GUTTER = 24;

export function useFillHeight({
  min = DEFAULT_MIN,
  gutter = DEFAULT_GUTTER,
}: FillHeightOptions = {}): FillHeight {
  const [element, setElement] = React.useState<HTMLElement | null>(null);
  const [height, setHeight] = React.useState(min);

  React.useLayoutEffect(() => {
    if (!element || typeof window === 'undefined') return;

    let frame: number | null = null;
    let last = -1;

    const measure = () => {
      frame = null;
      const top = element.getBoundingClientRect().top + window.scrollY;
      const next = Math.max(min, Math.round(window.innerHeight - top - gutter));
      // A sub-pixel difference is not a layout change, and re-rendering on one
      // is how a ResizeObserver ends up reporting an undelivered notification.
      if (Math.abs(next - last) < 1) return;
      last = next;
      setHeight(next);
    };

    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', schedule);

    // What moves this region is everything above it — a notice appearing, a
    // heading wrapping, a facts band gaining a row. The body is the one node
    // that sees all of them.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(document.body);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [element, min, gutter]);

  return { ref: setElement, height };
}
