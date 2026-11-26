/**
 * The link Null AI prints when it starts ends in `#key=…`. A browser never sends the part after `#`
 * to a server, so the key reaches only this page. It is taken out of the address at once, then traded
 * at `POST /api/auth/claim` for the owner cookie, which this browser keeps.
 */
const KEY_IN_FRAGMENT = /(?:^#|&)key=([A-Za-z0-9_-]{43})(?:&|$)/;

export async function claimOwnerKeyFromLink(): Promise<void> {
  const match = KEY_IN_FRAGMENT.exec(window.location.hash);
  if (!match) return;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  try {
    await fetch('/api/auth/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ key: match[1] }),
    });
  } catch {
    // The door explains what to do when the key did not take.
  }
}
