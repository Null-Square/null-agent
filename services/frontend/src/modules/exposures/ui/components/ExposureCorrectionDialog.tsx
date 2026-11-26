import { useEffect, useState, type FormEvent } from 'react';
import { Button, Modal, ModalContent } from '@null-ai/design-tokens/ui';

export type ExposureCorrectionKind =
  | 'not_present'
  | 'version_correction'
  | 'advisory_not_applicable';

export type ExposureCorrectionInput = {
  kind: ExposureCorrectionKind;
  reason: string;
  correctedVersion?: string;
};

const OPTIONS: Array<{
  kind: ExposureCorrectionKind;
  label: string;
  description: string;
}> = [
  {
    kind: 'not_present',
    label: 'Software is not installed',
    description: 'Stop matching this component on this asset until the correction is removed.',
  },
  {
    kind: 'version_correction',
    label: 'Detected version is wrong',
    description: 'Use the version you provide when evaluating this component against CVEs.',
  },
  {
    kind: 'advisory_not_applicable',
    label: 'This advisory does not apply',
    description: 'Close only this CVE match. The component inventory remains unchanged.',
  },
];

export function ExposureCorrectionDialog({
  open,
  componentName,
  currentVersion,
  isSaving,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  componentName: string;
  currentVersion: string | null;
  isSaving: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (input: ExposureCorrectionInput) => void;
}) {
  const [kind, setKind] = useState<ExposureCorrectionKind>('version_correction');
  const [reason, setReason] = useState('');
  const [correctedVersion, setCorrectedVersion] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind('version_correction');
    setReason('');
    setCorrectedVersion('');
    setValidationError(null);
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanReason = reason.trim();
    const cleanVersion = correctedVersion.trim();
    if (kind === 'version_correction' && !cleanVersion) {
      setValidationError('Enter the version that is actually running.');
      return;
    }
    if (cleanReason.length < 3) {
      setValidationError('Add a short reason so this correction can be audited later.');
      return;
    }
    setValidationError(null);
    onSubmit({
      kind,
      reason: cleanReason,
      ...(kind === 'version_correction' ? { correctedVersion: cleanVersion } : {}),
    });
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => !isSaving && onClose()}
      title="Correct this match"
      size="md"
    >
      <ModalContent>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Tell Threat Watch what is wrong about {componentName}
          {currentVersion ? ` ${currentVersion}` : ''}. Component corrections affect future
          matching; advisory corrections close only this alert.
        </p>

        <form onSubmit={submit} className="space-y-5">
            <fieldset className="space-y-2">
              <legend className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                What needs correcting?
              </legend>
              {OPTIONS.map((option) => (
                <label
                  key={option.kind}
                  className={`flex cursor-pointer gap-3 border p-4 transition-colors ${
                    kind === option.kind
                      ? 'border-primary bg-primary/5'
                      : 'border-border/60 bg-background hover:border-primary/40'
                  }`}
                >
                  <input
                    type="radio"
                    name="correction-kind"
                    value={option.kind}
                    checked={kind === option.kind}
                    onChange={() => {
                      setKind(option.kind);
                      setValidationError(null);
                    }}
                    className="mt-1 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{option.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>

            {kind === 'version_correction' ? (
              <label className="block">
                <span className="mb-2 block text-sm font-medium text-foreground">Correct version</span>
                <input
                  value={correctedVersion}
                  maxLength={120}
                  onChange={(event) => setCorrectedVersion(event.target.value)}
                  placeholder="For example, 6.4.3"
                  className="h-11 w-full border border-border/60 bg-background px-3 font-mono text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
            ) : null}

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Reason</span>
              <textarea
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="What did you check?"
                rows={3}
                className="w-full resize-none border border-border/60 bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                Saved with your account for the audit trail.
              </span>
            </label>

            {validationError || error ? (
              <p role="alert" className="text-sm text-destructive">{validationError ?? error}</p>
            ) : null}

            <div className="flex justify-end gap-3 border-t border-border pt-5">
              <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" loading={isSaving}>
                {isSaving ? 'Saving' : 'Save correction'}
              </Button>
            </div>
        </form>
      </ModalContent>
    </Modal>
  );
}
