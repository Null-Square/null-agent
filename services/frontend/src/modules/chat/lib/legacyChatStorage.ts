/**
 * Removes the chat transcripts an earlier build wrote to localStorage.
 *
 * Chat used to keep its own copy of every message under
 * `nullsquare.chatSession:<id>`, from before sessions were server-owned. The
 * server snapshot took over hydration and the reader was deleted, but the
 * writer stayed — so the app went on copying whole transcripts into a store
 * nothing read. A workbench run, whose assistant messages carry tool output,
 * reached the 5MB origin quota at 29 messages; `setItem` threw inside a render
 * effect and took the chat provider down with it.
 *
 * The writer is gone now. This clears what it left behind: until these keys are
 * removed they hold the origin near its quota, where the next feature to want
 * localStorage fails instead.
 *
 * Safe to call on every boot — once the keys are gone it does nothing. Reading
 * localStorage throws outright in some privacy modes, so the whole sweep is
 * guarded rather than each removal.
 */

const LEGACY_INDEX_KEY = 'nullsquare.chatSessions';
const LEGACY_SESSION_PREFIX = 'nullsquare.chatSession:';

export const purgeLegacyChatStorage = (): void => {
  if (typeof window === 'undefined') return;
  try {
    const { localStorage } = window;
    const stale = Object.keys(localStorage).filter(
      (key) => key === LEGACY_INDEX_KEY || key.startsWith(LEGACY_SESSION_PREFIX),
    );
    for (const key of stale) {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage is unavailable or blocked. Nothing to reclaim, nothing to report:
    // a browser that will not let us read it will not let the old build write
    // to it either.
  }
};
