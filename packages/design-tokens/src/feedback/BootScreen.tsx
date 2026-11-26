import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { LoadingScreen } from './LoadingScreen';
import { useMinimumVisible } from './useMinimumVisible';

/**
 * ONE boot screen element for the whole app, owned above every guard.
 *
 * ── WHY A PROVIDER AND NOT JUST A SHARED COMPONENT ──
 * Making every guard render the same `<LoadingScreen />` fixed the *look* and
 * not the *behaviour*. Booting crosses several guards in sequence — the
 * platform-settings check, the auth check, the setup check, the lazy chunk, the
 * subscription read — and each one is a separate `return` in a separate
 * component. React therefore unmounts one loader and mounts the next, so the
 * reveal animation replays at every handoff: the logo fades in, dies, fades in
 * again. Identical pixels, three or four entrances. That is what "it flickers
 * and restarts about three times" is.
 *
 * A component cannot hold itself across its own unmount, so the element has to
 * live somewhere neither guard owns. This provider is that place: guards no
 * longer render a loader, they SAY they are still booting, and the one element
 * up here stays mounted for as long as anybody is saying it. The animation
 * plays exactly once, however many stages the boot passes through.
 *
 * ── AND IT STILL CANNOT FLASH ──
 * The hold lives here too, once, for the same reason: a per-guard minimum could
 * only measure that guard's own life. Measured here it covers the whole boot,
 * including the moment between two guards when nothing is loading for a frame.
 * Without that, the handoff itself would blink.
 */

type BootScreenContextValue = {
  begin: (key: string) => void;
  end: (key: string) => void;
};

const BootScreenContext = createContext<BootScreenContextValue | null>(null);

export interface BootScreenProviderProps {
  children: React.ReactNode;
  /** How long the screen stays once shown. See `useMinimumVisible`. */
  minVisibleMs?: number;
}

export const BootScreenProvider: React.FC<BootScreenProviderProps> = ({
  children,
  minVisibleMs = 500,
}) => {
  /* A SET of reasons, not a counter. Two guards can be booting at once, and a
     counter that goes 1 → 0 → 1 as one hands over to the next would tear the
     element down in between — the exact restart this exists to prevent. With
     keys, the set is only empty when nothing at all is waiting. */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());

  const begin = useCallback((key: string) => {
    setWaiting((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  const end = useCallback((key: string) => {
    setWaiting((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ begin, end }), [begin, end]);
  const booting = useMinimumVisible(waiting.size > 0, minVisibleMs);

  return (
    <BootScreenContext.Provider value={value}>
      {children}
      {booting ? (
        <div className="fixed inset-0 z-[9999]">
          <LoadingScreen />
        </div>
      ) : null}
    </BootScreenContext.Provider>
  );
};

/**
 * Say "I am still booting" for as long as `active` is true.
 *
 * The caller renders NOTHING for its waiting state — it returns `null` and lets
 * the one screen above cover the page. `key` names the stage so two overlapping
 * waits do not cancel each other; any stable string per call site will do.
 *
 * Outside a `BootScreenProvider` this is inert rather than an error, so a page
 * rendered in isolation (a test, a storybook) does not have to build the whole
 * app shell to render.
 */
export const useBootScreen = (active: boolean, key: string): void => {
  const context = useContext(BootScreenContext);

  useEffect(() => {
    if (!context || !active) return;
    context.begin(key);
    return () => context.end(key);
  }, [context, active, key]);
};
