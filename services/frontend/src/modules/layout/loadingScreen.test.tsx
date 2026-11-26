/* @vitest-environment jsdom */

import { render, screen, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BootScreenProvider, LoadingScreen, useBootScreen, useMinimumVisible } from '@null-ai/design-tokens/ui';

/**
 * THE BOOT SCREEN IS THE FIRST THING A CUSTOMER SEES, AND IT WAS THE WORST.
 *
 * Signing in crossed three waiting states with three different captions, each
 * appearing and vanishing in a frame or two. Nothing was broken; it only looked
 * broken, which for the first screen after sign-in is the same problem.
 *
 * These pin the two properties that fix it — one image rather than a narration,
 * and a floor on how briefly it can appear.
 */
describe('the boot screen', () => {
  it('says nothing by default, so nothing can change under the reader', () => {
    const { container } = render(<LoadingScreen />);

    /* A caption that changes between stages is what made the old sequence read
       as several things going wrong. The default has no words at all. */
    expect(container.textContent?.trim()).toBe('');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('is one component, so every surface waits the same way', () => {
    /* Both lockups ship and CSS chooses: the screen paints before any theme
       provider mounts, and a logo that swaps a frame later is its own flicker. */
    const { container } = render(<LoadingScreen />);
    expect(container.querySelector('.ns-loader-ink-light')).toBeTruthy();
    expect(container.querySelector('.ns-loader-ink-dark')).toBeTruthy();
    expect(container.querySelector('.ns-loader-sweep')).toBeTruthy();
  });

  it('can still explain an unusual wait when asked', () => {
    render(<LoadingScreen label="Restoring your session" />);
    expect(screen.getByText('Restoring your session')).toBeTruthy();
  });
});

describe('the minimum visible hold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds a loader that would otherwise blink and vanish', () => {
    const { result, rerender } = renderHook(({ on }) => useMinimumVisible(on, 500), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(true);

    /* The request comes back almost immediately — the case that produced the
       flash. The screen must stay put rather than tear down mid-frame. */
    act(() => { vi.advanceTimersByTime(80); });
    rerender({ on: false });
    expect(result.current).toBe(true);

    act(() => { vi.advanceTimersByTime(419); });
    expect(result.current, 'still inside the minimum').toBe(true);

    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current, 'minimum elapsed, it may go').toBe(false);
  });

  it('does not delay a load that was already slow', () => {
    const { result, rerender } = renderHook(({ on }) => useMinimumVisible(on, 500), {
      initialProps: { on: true },
    });

    act(() => { vi.advanceTimersByTime(900); });
    rerender({ on: false });

    /* Past the minimum the hold has already been paid — adding more would make
       a slow app feel slower for no benefit. */
    expect(result.current).toBe(false);
  });

  it('never shows anything when it was never loading', () => {
    const { result } = renderHook(() => useMinimumVisible(false, 500));
    expect(result.current).toBe(false);
  });
});

/**
 * ── THE FLICKER WAS NEVER THE ANIMATION, IT WAS THE REMOUNTING ──
 * Booting crosses several guards, each with its own `return`. When each drew
 * its own loader, React unmounted one and mounted the next, so the entrance
 * animation replayed at every handoff — "it flickers and restarts about three
 * times". Identical pixels did not fix it; only one element can.
 */
const Stage = ({ active, name }: { active: boolean; name: string }) => {
  useBootScreen(active, name);
  return null;
};

describe('the boot screen singleton', () => {
  it('shows one screen, however many stages are waiting', () => {
    const { container } = render(
      <BootScreenProvider>
        <Stage active name="platform-settings" />
        <Stage active name="auth" />
        <Stage active name="subscription" />
      </BootScreenProvider>,
    );

    expect(container.querySelectorAll('[role="status"]').length).toBe(1);
  });

  it('keeps the very same element as one stage hands over to the next', () => {
    const { container, rerender } = render(
      <BootScreenProvider>
        <Stage active name="auth" />
        <Stage active={false} name="subscription" />
      </BootScreenProvider>,
    );
    const first = container.querySelector('[role="status"]');
    expect(first).toBeTruthy();

    /* Auth finishes exactly as the subscription read begins — the handoff that
       used to tear the screen down and build it again. */
    rerender(
      <BootScreenProvider>
        <Stage active={false} name="auth" />
        <Stage active name="subscription" />
      </BootScreenProvider>,
    );

    /* Same node identity: React reused it, so the animation never restarted. */
    expect(container.querySelector('[role="status"]')).toBe(first);
  });

  it('renders nothing at all once every stage is done', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(
        <BootScreenProvider>
          <Stage active name="auth" />
        </BootScreenProvider>,
      );
      expect(container.querySelector('[role="status"]')).toBeTruthy();

      act(() => { vi.advanceTimersByTime(600); });
      rerender(
        <BootScreenProvider>
          <Stage active={false} name="auth" />
        </BootScreenProvider>,
      );
      act(() => { vi.advanceTimersByTime(600); });

      expect(container.querySelector('[role="status"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /* A page rendered on its own — a test, a preview — must not need the whole
     app shell just to render. */
  it('is inert with no provider above it', () => {
    expect(() => render(<Stage active name="auth" />)).not.toThrow();
  });
});
