import { useEffect, useState } from 'react';
import { AlertCircle, Check, Copy, ShieldAlert } from 'lucide-react';
import { Button, Modal, ModalContent, ModalFooter } from '@null-ai/design-tokens/ui';
import {
  useVerifyTargetMutation,
  useAutoVerifyTargetMutation,
  type ScopeTarget,
} from '@/modules/security-ops/api';
import { buildTargetVerificationInstructions } from '@null-ai/contracts';
import { cn } from '@/shared/lib/utils';
import { isScopeAutoVerifyEnabled } from '@/modules/scopes/lib/autoVerify';
import { celebrateTargetVerified } from '@/modules/scopes/model/verificationCelebration';

interface TargetVerificationModalProps {
  open: boolean;
  target: ScopeTarget | null;
  scopeId: string;
  onClose: () => void;
}

type ManualVerificationMethod = 'dns_txt' | 'http_well_known';

const manualMethodLabel = (method: ManualVerificationMethod) =>
  method === 'http_well_known' ? 'HTTPS File' : 'DNS TXT';

export default function TargetVerificationModal({ open, target, scopeId, onClose }: TargetVerificationModalProps) {
  const verifyTarget = useVerifyTargetMutation();
  const autoVerifyTarget = useAutoVerifyTargetMutation();
  const autoVerifyEnabled = isScopeAutoVerifyEnabled();
  const [copiedHost, setCopiedHost] = useState(false);
  const [copiedValue, setCopiedValue] = useState(false);
  const [method, setMethod] = useState<ManualVerificationMethod>('dns_txt');
  /* The route answers 200 with `verified: false` when the record is not visible
     yet. That is the common case on a first attempt, and it also closed the
     modal as though it had worked. */
  const [verifyFailure, setVerifyFailure] = useState<string | null>(null);

  const targetId = target?.id;
  const targetVerificationMethod = target?.verificationMethod;
  const selectedManualMethod: ManualVerificationMethod = method;

  // The portal, the escape key and the scroll lock belong to `Modal`.

  useEffect(() => {
    if (open && targetId) {
      setMethod(targetVerificationMethod === 'http_well_known' ? 'http_well_known' : 'dns_txt');
    }
  }, [open, targetId, targetVerificationMethod]);

  if (!open || !target) return null;

  const isHttpVerification = selectedManualMethod === 'http_well_known';
  const instructions = buildTargetVerificationInstructions(target.value, target.verificationToken ?? '');
  const hostRecord = instructions.dnsHost;
  const verificationUrl = instructions.httpUrl;
  const tokenValue = instructions.expectedValue;

  const copyToClipboard = (text: string, setCopied: (v: boolean) => void) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const selectMethod = (nextMethod: ManualVerificationMethod) => {
    setMethod(nextMethod);
  };

  const handleVerify = () => {
    const domain = target.value;
    setVerifyFailure(null);
    verifyTarget.mutate(
      { scopeId, targetId: target.id, method: selectedManualMethod },
      {
        /* A 200 here means the CHECK ran, not that it passed. Closing on the
           response without reading `verified` reported a failed lookup as a
           success and dropped the reason the route had already written. */
        onSuccess: (result) => {
          if (!result?.verified) {
            setVerifyFailure(result?.message ?? 'We could not find the record yet. DNS can take a few minutes to publish.');
            return;
          }
          /* Hand the celebration to the app and get out of the way. It cannot
             live here: this modal is unmounted by the refetch that the success
             itself triggers. See `verificationCelebration.ts`. */
          celebrateTargetVerified(domain);
          onClose();
        },
      },
    );
  };

  const handleDevAutoVerify = () => {
    const domain = target.value;
    autoVerifyTarget.mutate(
      { scopeId, targetId: target.id },
      {
        onSuccess: () => {
          celebrateTargetVerified(domain);
          onClose();
        },
      },
    );
  };

  const primaryActionLabel = `Verify and authorize (${manualMethodLabel(selectedManualMethod)})`;
  const primaryActionDisabled = verifyTarget.isPending
    || autoVerifyTarget.isPending;

  return (
    <Modal isOpen={open} onClose={onClose} title="Verify and authorize" size="md">
      <ModalContent className="space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Complete validation for{' '}
            <span className="font-mono font-bold text-foreground">{target.value}</span>.
          </p>

          {verifyFailure ? (
            <div
              className="flex items-start gap-3 border border-destructive/40 bg-destructive/5 p-3"
              role="status"
              aria-live="polite"
            >
              <AlertCircle className="mt-[2px] h-4 w-4 flex-none text-destructive" />
              <p className="text-sm leading-relaxed text-foreground">{verifyFailure}</p>
            </div>
          ) : null}

          <div className="space-y-5">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
                  Method
                </span>
              </div>

              <div className="flex max-w-full overflow-x-auto border border-border/60 bg-muted/20 p-1">
                {([
                  ['dns_txt', 'DNS TXT'],
                  ['http_well_known', 'HTTPS File'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectMethod(id)}
                    className={cn(
                      'shrink-0 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-all',
                      method === id
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs font-mono leading-relaxed text-muted-foreground/80">
              {isHttpVerification
                ? 'Publish this token at the verification URL to verify ownership.'
                : 'Add this DNS TXT record to verify ownership.'}
            </p>

            <div className="space-y-4">
              <div className="border border-border/40 bg-surface-1/40 p-5 transition-all hover:border-primary/30">
                <div className="mb-3 flex items-start justify-between">
                  <label className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
                    {isHttpVerification ? 'Verification URL' : 'DNS Host (Name)'}
                  </label>
                  <span className="rounded border border-primary/20 px-1.5 py-0.5 text-[10px] font-mono font-bold tracking-widest text-primary/60">
                    {isHttpVerification ? 'HTTPS' : 'TXT'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <code className="break-all font-mono text-[11px] text-foreground">
                    {isHttpVerification ? verificationUrl : hostRecord}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(isHttpVerification ? verificationUrl : hostRecord, setCopiedHost)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  >
                    {copiedHost ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>

              <div className="border border-border/40 bg-surface-1/40 p-5 transition-all hover:border-primary/30">
                <div className="mb-3 flex items-start justify-between">
                  <label className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-muted-foreground/70">
                    {isHttpVerification ? 'File Body' : 'DNS Value (Content)'}
                  </label>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <code className="break-all font-mono text-[11px] font-bold text-primary">{tokenValue}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyToClipboard(tokenValue, setCopiedValue)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:bg-primary/5 hover:text-primary"
                  >
                    {copiedValue ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 border-l-2 border-primary/50 bg-primary/[0.03] p-4 text-[10px] text-muted-foreground">
              <AlertCircle className="h-4 w-4 flex-shrink-0 text-primary/70" />
              <span className="font-mono leading-relaxed opacity-80">
                {isHttpVerification
                  ? 'The verification file must be reachable from this exact host over HTTPS. Redirects are followed.'
                  : 'DNS propagation speed depends on your provider. Records may take 5-10 minutes to populate.'}
              </span>
            </div>

            {/* What verifying this record means.
                Publishing the token proves control of the zone, and control is
                what NullSquare acts on: completing this step is the customer's
                authorization to test the target, which is why the dialog says
                so in the words the action is taken under rather than hiding it
                behind a second confirmation somewhere else. */}
            <p
              data-testid="target-authorization-statement"
              className="border-l-2 border-primary/50 pl-4 text-sm leading-relaxed text-muted-foreground"
            >
              By verifying this target you confirm that you own it, or have authority from the
              owner to authorize security testing of it. NullSquare acts on that confirmation and
              does not independently verify ownership.
            </p>
          </div>
      </ModalContent>

      <ModalFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        {autoVerifyEnabled && !target.verified ? (
          <Button
            variant="destructive"
            onClick={handleDevAutoVerify}
            loading={autoVerifyTarget.isPending}
            disabled={verifyTarget.isPending}
            title="Development only: bypass ownership verification"
          >
            {autoVerifyTarget.isPending ? null : <ShieldAlert className="h-4 w-4" />}
            Dev auto-verify
          </Button>
        ) : null}
        <Button
          onClick={handleVerify}
          loading={verifyTarget.isPending}
          disabled={Boolean(primaryActionDisabled)}
          data-testid="target-verify-submit"
        >
          {verifyTarget.isPending ? (
            'Verifying'
          ) : (
            primaryActionLabel
          )}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
