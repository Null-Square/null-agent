import { useSyncExternalStore } from 'react';

/**
 * "A target was just verified" — held outside the React tree on purpose.
 *
 * ── WHY THIS IS NOT COMPONENT STATE ─────────────────────────────────────
 * The celebration used to live in `TargetVerificationModal`, and the success
 * that triggers it is the same event that destroys it:
 *
 *   `useVerifyTargetMutation` invalidates `scope-targets` on success, the
 *   refetch flips `primaryTarget.verified`, and `DashboardPage` — which
 *   renders the modal in BOTH its unverified-gate branch and its main branch —
 *   swaps branches. React unmounts one modal and mounts a different one, the
 *   state goes with it, and the customer is handed the verify form again as
 *   though nothing had happened.
 *
 * So the fact belongs to the app, not to whichever surface happened to ask
 * for the verification. One overlay reads this in `AppLayout`, above the
 * router, where nothing that a successful verification does can unmount it —
 * and every surface that verifies gets the celebration for free.
 */

export interface TargetVerifiedCelebration {
  domain: string;
}

let current: TargetVerifiedCelebration | null = null;
const listeners = new Set<() => void>();

const emit = () => { listeners.forEach((l) => l()); };

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/* Reassigned only when it actually changes, so the reference stays stable and
   `useSyncExternalStore` does not loop. */
const getSnapshot = () => current;
const getServerSnapshot = () => null;

export const celebrateTargetVerified = (domain: string) => {
  current = { domain };
  emit();
};

export const dismissTargetVerified = () => {
  if (!current) return;
  current = null;
  emit();
};

export const useTargetVerifiedCelebration = () =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
