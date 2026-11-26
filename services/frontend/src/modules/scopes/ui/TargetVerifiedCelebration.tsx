import { CelebrationOverlay } from '@null-ai/design-tokens/ui';

import {
  dismissTargetVerified,
  useTargetVerifiedCelebration,
} from '@/modules/scopes/model/verificationCelebration';

/**
 * The one mount point for the "target verified" celebration.
 *
 * Lives in `AppLayout`, above the router, because the surface that triggers it
 * is routinely unmounted by the very success it is celebrating — see
 * `verificationCelebration.ts` for the whole shape of that bug.
 */
export const TargetVerifiedCelebration = () => {
  const celebration = useTargetVerifiedCelebration();

  return (
    <CelebrationOverlay
      open={Boolean(celebration)}
      title="Target verified"
      description={
        <>
          <span className="font-mono text-white">{celebration?.domain}</span> is yours, and the
          first assessment has already started — it is included with verification. We will notify
          you once surface mapping is complete, and the report goes to your email.
        </>
      }
      actionLabel="Continue"
      onClose={dismissTargetVerified}
    />
  );
};
