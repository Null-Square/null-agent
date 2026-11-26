/**
 * Turns "something changed" events from the server into refetches.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Until this, a page refreshed when *you* caused the change — a mutation in
 * your own tab invalidated its own queries — or when the page happened to
 * poll. Everything an agent produced while you were not looking sat invisible
 * until a manual refresh. Since the product's whole value is agents working
 * unattended, the app was blind to exactly the changes it exists to produce.
 *
 * HOW IT WORKS
 *
 * The server sends a coarse kind ("risks changed"), never the row. This hook
 * answers by invalidating the matching query keys, and React Query refetches
 * only the ones actually mounted. So an event costs at most one request per
 * open page, the refetch goes through the ordinary authorised endpoint, and a
 * dropped event can never leave a wrong row in the cache — only a stale panel
 * until the next event or navigation.
 *
 * Mount it once, high in the tree.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { subscribeToStream, type LiveEvent, type LiveEventKind } from '@/shared/lib/liveEventStream';

/**
 * Which caches each kind invalidates, as key prefixes.
 *
 * Prefixes rather than exact keys: `['risks']` covers `['risks', scopeId]` for
 * every scope the tab has cached, which is what we want — the event does not
 * say which scope, and only the mounted one costs a request.
 *
 * Deliberately absent: `run-phases`, `run-events`, `run-activity`. Those track
 * progress *within* a run at a granularity no event here reports, and the run
 * detail page already polls for them.
 */
const INVALIDATIONS: Record<LiveEventKind, ReadonlyArray<readonly string[]>> = {
  'risk.created': [['risks'], ['asset-findings'], ['dashboard-summary']],
  'asset.discovered': [['assets'], ['dashboard-summary']],
  'run.created': [['runs'], ['dashboard-summary']],
  'run.changed': [['runs'], ['run'], ['dashboard-summary']],
};

/**
 * A single run reports findings in bursts, and each one is an event. Without
 * coalescing, a run that lands twenty findings would fire twenty identical
 * invalidations and twenty refetches of the same list — the shape of request
 * storm this codebase has already had to fix once, and the reason
 * `queryClient.ts` carries a `staleTime` at all.
 *
 * A trailing window collapses a burst into one refetch. It is short enough to
 * still read as instant.
 */
const COALESCE_MS = 400;

export function useLiveDataSync(enabled = true): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return undefined;

    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      const keys = [...pending];
      pending.clear();
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: JSON.parse(key) as string[] });
      }
    };

    const unsubscribe = subscribeToStream('live', (data) => {
      const event = data as LiveEvent;
      const targets = INVALIDATIONS[event.kind];
      // An unknown kind means a newer server than this tab. Ignoring it is
      // correct: the tab simply refreshes on the kinds it does understand.
      if (!targets) return;

      for (const target of targets) pending.add(JSON.stringify(target));
      if (timer === null) timer = setTimeout(flush, COALESCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, queryClient]);
}

export default useLiveDataSync;
