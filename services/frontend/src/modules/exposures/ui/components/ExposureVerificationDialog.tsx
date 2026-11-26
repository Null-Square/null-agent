import { AlertDialog } from '@null-ai/design-tokens/ui';

export type ExposureVerificationTarget = {
  id: string;
  advisoryId: string;
  assetValue: string;
};

export function ExposureVerificationDialog({
  target,
  onConfirm,
  onCancel,
}: {
  target: ExposureVerificationTarget | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      isOpen={target !== null}
      title="START FOCUSED VERIFICATION"
      description={
        target
          ? `Test ${target.advisoryId} against ${target.assetValue}. This starts a focused assessment. The result may be confirmed exploitable, not reproduced, or inconclusive.`
          : ''
      }
      confirmLabel="START VERIFICATION"
      cancelLabel="CANCEL"
      variant="warning"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
