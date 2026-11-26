import { Copy, CheckCircle } from 'lucide-react';
import { Button, Input } from '@null-ai/design-tokens/ui';
import { motion } from 'framer-motion';
import type { SetupFormData } from '../types';
import { cn } from '@shared/lib/utils';
import { toastService } from '@shared/services/toastService';
import { buildTargetVerificationInstructions } from '@null-ai/contracts';

const DOMAIN_VERIFICATION_METHODS = [
  { id: 'dns_txt', label: 'DNS' },
  { id: 'http_well_known', label: 'HTTP' },
] as const;

export default function Step2Target({
  data,
  updateData,
  verificationStatus,
  verificationMessage,
  verificationToken,
  isPolling,
  onVerify,
  isVerifying,
}: {
  data: SetupFormData;
  updateData: (data: Partial<SetupFormData>) => void;
  verificationStatus: 'idle' | 'pending' | 'success' | 'failed';
  verificationMessage: string;
  verificationToken: string | null;
  isPolling: boolean;
  onVerify: () => Promise<void>;
  isVerifying: boolean;
}) {
  const isVerified = data.isTargetVerified;
  const showVerificationChoice = data.targetValue.trim().length > 3 && !isVerified;

  const handleValueChange = (value: string) => {
    updateData({
      targetType: 'domain',
      targetValue: value,
      isTargetVerified: false,
    });
  };

  const copyToClipboard = (text: string) => {
    void navigator.clipboard.writeText(text);
    toastService.success('Copied', 'Value copied to clipboard.');
  };

  // Derived from the shared @null-ai/contracts spec so onboarding can never show
  // instructions that differ from what the backend verifier actually checks.
  const instructions =
    data.targetValue && verificationToken
      ? buildTargetVerificationInstructions(data.targetValue, verificationToken)
      : null;
  const verificationUrl = instructions?.httpUrl ?? '';
  const hostRecord = instructions?.dnsHost ?? '';
  const tokenValue = instructions?.expectedValue ?? '';
  const selectedManualMethodLabel =
    data.domainVerificationMethod === 'http_well_known' ? 'HTTP File' : 'DNS Record';

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8 ">
      <div className="relative group">
        <Input
          id="target-value"
          aria-label="Target value"
          value={data.targetValue}
          onChange={(e) => handleValueChange(e.target.value)}
          placeholder="example.com"
          className={cn(
            // Same frame as step one; mono because a hostname is real data.
            'h-14 px-6 text-center text-base font-mono font-bold tracking-tight text-foreground placeholder:text-muted-foreground/40 focus:border-primary focus-visible:ring-0',
          )}
        />
        <div className="absolute right-5 top-1/2 -translate-y-1/2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
            Website
          </span>
        </div>
      </div>

      {isVerified ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-center justify-center gap-3 border-l-2 border-success py-4 pl-5 text-foreground"
        >
          <CheckCircle className="h-5 w-5 text-primary" />
          <p className="text-sm">{verificationMessage || 'Target verified'}</p>
        </motion.div>
      ) : showVerificationChoice ? (
        <div className="flex w-full flex-col gap-5 pt-4">
          {verificationToken ? (
              <motion.div
                key="verification-instructions"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full border border-border/40 p-6 text-left "
              >
                <div className="mb-5 flex items-center justify-between gap-3 border-b border-border/40 pb-4">
                  <p className="text-sm text-primary">
                    Verify this domain
                  </p>
                  <div className="flex border border-border p-1">
                    {DOMAIN_VERIFICATION_METHODS.map((method) => (
                      <button
                        key={method.id}
                        onClick={() => updateData({ domainVerificationMethod: method.id })}
                        className={cn(
                          "px-3 py-1.5 text-sm transition-all ",
                          data.domainVerificationMethod === method.id
                            ? "bg-foreground text-background font-black "
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {method.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-5">
                  <p className="text-[11px] leading-relaxed text-muted-foreground font-sans">
                    {data.domainVerificationMethod === 'http_well_known'
                      ? 'Serve this token from the well-known verification URL below.'
                      : 'Add this TXT record to your DNS configuration to prove ownership.'} Successful verification authorizes NullSquare to start the one-time discovery assessment automatically.
                  </p>

                  <div className="space-y-4">
                    <div className="border border-border p-4 ">
                      <p className="mb-2 text-sm text-muted-foreground/60">
                        {data.domainVerificationMethod === 'http_well_known' ? 'URL Endpoint' : 'DNS Host'}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(
                            data.domainVerificationMethod === 'http_well_known' ? verificationUrl : hostRecord,
                          )}
                        className="w-full break-all text-left font-mono text-[12px] text-foreground transition-colors hover:text-primary leading-relaxed"
                      >
                        {data.domainVerificationMethod === 'http_well_known' ? verificationUrl : hostRecord}
                      </button>
                    </div>

                    <div className="border border-border p-4 ">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <p className="mb-2 text-sm text-muted-foreground/60">
                            {data.domainVerificationMethod === 'http_well_known' ? 'File Content' : 'TXT Value'}
                          </p>
                          <p className="break-all font-mono text-[12px] text-primary leading-relaxed">{tokenValue}</p>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-primary/60 border border-primary/20 hover:bg-primary/10 hover:text-primary shrink-0 "
                          onClick={() => copyToClipboard(tokenValue)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col items-center gap-4 border-t border-border/20 pt-5">
                    <Button
                      variant="outline"
                      onClick={onVerify}
                      disabled={isVerifying}
                      className="h-11 w-full font-mono uppercase text-[10px] font-bold tracking-widest border-border hover:bg-muted hover:text-foreground transition-all"
                    >
                      {isVerifying ? 'Verifying' : 'Verify & start discovery'}
                    </Button>

                    {isPolling && (
                      <div className="flex items-center gap-2.5 text-sm text-primary">
                        <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden />
                        <span>Polling registry</span>
                      </div>
                    )}

                    {verificationStatus === 'failed' && verificationMessage && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-destructive/5 border border-destructive/20">
                        <p className="text-sm text-destructive">
                          {verificationMessage}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
          ) : (
            <motion.div
              key="verification-options"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full border border-border/40 p-6 text-left "
            >
              <div className="flex flex-col gap-4 border-b border-border/40 pb-4 md:flex-row md:items-center md:justify-between">
                <p className="text-sm text-primary">
                  Verification Method
                </p>
                <div className="flex max-w-full overflow-x-auto border border-border p-1">
                  <button
                    type="button"
                    onClick={() => {
                      updateData({ domainVerificationMethod: 'dns_txt' });
                    }}
                    className={cn(
                      "shrink-0 px-3 py-1.5 text-sm transition-all",
                      data.domainVerificationMethod === 'dns_txt'
                        ? "bg-foreground text-background font-black "
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    DNS Record
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      updateData({ domainVerificationMethod: 'http_well_known' });
                    }}
                    className={cn(
                      "shrink-0 px-3 py-1.5 text-sm transition-all",
                      data.domainVerificationMethod === 'http_well_known'
                        ? "bg-foreground text-background font-black "
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    HTTP File
                  </button>
                </div>
              </div>

                <div className="mt-6 flex flex-col gap-4">
                  <p className="text-[11px] leading-relaxed text-muted-foreground/80 font-sans">
                    {data.domainVerificationMethod === 'http_well_known'
                      ? 'Serve one verification file from the public website. Best when you control hosting.'
                      : 'Add one TXT record at your DNS provider. Best when you control domain DNS.'}
                  </p>
                  <Button
                    variant="primary"
                    onClick={onVerify}
                    loading={isVerifying}
                    disabled={!data.targetValue}
                    className="h-11 w-full font-mono uppercase text-[10px] font-bold tracking-widest"
                  >
                    {isVerifying ? 'Preparing' : `Show ${selectedManualMethodLabel} instructions`}
                  </Button>
                </div>
            </motion.div>
          )}
        </div>
      ) : null}
    </div>
  );
}
