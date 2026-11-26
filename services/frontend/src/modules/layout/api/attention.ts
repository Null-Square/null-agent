/**
 * The nav "new item" mark — does this menu item have something I have not
 * checked?
 *
 * That is the entire question, and the entire feature. A count per destination
 * answers it; opening the destination clears it. Nothing here knows which
 * individual rows are new, because that is not a question anybody asks of a
 * menu.
 *
 * Deliberately separate from `useUnreadCount` and the notification bell. The
 * bell answers "what happened, tell me once" and clears when its panel is
 * opened; this clears only when you arrive at the destination itself. Opening
 * the bell must not clear a nav mark, which is why these are two systems.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { authenticatedFetch } from '@shared/api';

/**
 * Keyed by `NavItem.id`. Surfaces the caller lacks the capability for are
 * ABSENT rather than zero, so a viewer who cannot read findings never learns
 * how many there are from the chrome — and so the client can tell "not tracked"
 * apart from "tracked, nothing new".
 */
export type AttentionCounts = Partial<Record<string, number>>;

export const attentionKey = ['nav-attention'] as const;

const EMPTY: AttentionCounts = {};

export const getAttention = async (): Promise<AttentionCounts> => {
  const data = await authenticatedFetch<{ attention: AttentionCounts }>('/api/app/attention');
  return data.attention ?? {};
};

/**
 * ── IT IS ALLOWED TO BE STALE, AND MUST NEVER BE LOUD ──
 * This decorates every screen in the console. A minute-old count is harmless;
 * a spinner, an error toast or a refetch storm on window focus is not. So it
 * holds for a minute, does not retry, and resolves to `{}` on failure — a
 * missing mark rather than a broken sidebar.
 */
export const useAttention = (enabled = true) =>
  useQuery({
    queryKey: attentionKey,
    queryFn: getAttention,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    placeholderData: EMPTY,
  });

/**
 * Record that they opened a destination, and drop its mark immediately.
 *
 * The mark clears before the round trip because the person is looking at the
 * page right now, and one that lingers for another 200ms reads as "it did not
 * work". On failure it refetches rather than restoring a remembered value: the
 * count is the server's to state, and asking again is more honest than keeping
 * a private copy that may already be wrong.
 *
 * ── THE CALLER MUST NOT TRIGGER THIS FROM THE COUNT ──
 * See `SidebarLayout`: the trigger is the arrival, never the number. Making the
 * count both the trigger and the thing this changes closes a feedback loop, and
 * that loop is not theoretical — it once sent 1,927 requests in fifteen minutes
 * and rate-limited every other endpoint in the app.
 */
export const useMarkSeen = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (surface: string) =>
      authenticatedFetch('/api/app/attention/seen', {
        method: 'POST',
        body: JSON.stringify({ surface }),
      }),
    onMutate: (surface: string) => {
      queryClient.setQueryData<AttentionCounts>(attentionKey, (current) =>
        current?.[surface] ? { ...current, [surface]: 0 } : current,
      );
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: attentionKey });
    },
    retry: false,
  });
};
