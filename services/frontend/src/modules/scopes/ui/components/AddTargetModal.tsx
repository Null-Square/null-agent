import { useMemo, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalContent,
  ModalFooter,
} from '@null-ai/design-tokens/ui';
import { Globe, Network, AlertCircle, ChevronRight } from 'lucide-react';
import { detectTargetType } from '@/shared/lib/validators';
import { cn } from '@/shared/lib/utils';

/**
 * A form, not a write.
 *
 * The modal used to add the target itself and carried its own authorization
 * checkbox, which put a legal statement on every panel of the scope page. It
 * now stages the target and closes; the page's Save is the single place the
 * boundary changes, and the single place the statement is asked for.
 */
interface AddTargetModalProps {
  open: boolean;
  existingTargets?: Array<{ type: string; value: string; verified?: boolean }>;
  onAdd: (target: {
    type: 'domain' | 'ip' | 'cidr' | 'url';
    value: string;
    verificationMethod?: string;
  }) => void;
  onClose: () => void;
}

const parseIpv4 = (value: string): number | null => {
  const trimmed = value.trim();
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) return null;
  const octets = trimmed.split('.').map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return (
    ((octets[0] << 24) >>> 0) |
    ((octets[1] << 16) >>> 0) |
    ((octets[2] << 8) >>> 0) |
    (octets[3] >>> 0)
  ) >>> 0;
};

const ipv4InCidr = (ip: string, cidr: string): boolean => {
  const [baseIp, prefixRaw] = cidr.split('/');
  const prefixLen = Number.parseInt(prefixRaw ?? '', 10);
  const ipInt = parseIpv4(ip);
  const baseInt = parseIpv4(baseIp ?? '');
  if (ipInt === null || baseInt === null || !Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    return false;
  }
  if (prefixLen === 0) return true;
  const mask = prefixLen === 32 ? 0xffffffff : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
};

const isPrivateCidrLike = (value: string): boolean => {
  const trimmed = value.trim();
  const ip = trimmed.includes('/') ? trimmed.split('/')[0] : trimmed;
  if (!ip || parseIpv4(ip) === null) {
    return false;
  }
  return ipv4InCidr(ip, '10.0.0.0/8') || ipv4InCidr(ip, '172.16.0.0/12') || ipv4InCidr(ip, '192.168.0.0/16');
};

const normalizeDomainInput = (value: string): string => {
  let domain = value.trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '');
  domain = domain.split('/')[0].split('?')[0].split('#')[0];
  domain = domain.split(':')[0];
  if (domain.startsWith('www.')) {
    domain = domain.slice(4);
  }
  return domain.replace(/^\.+|\.+$/g, '');
};

const buildAnchoredDomainTargetValue = (value: string, anchor: string): string => {
  const candidate = normalizeDomainInput(value);
  const normalizedAnchor = normalizeDomainInput(anchor);
  if (!candidate || !normalizedAnchor) {
    return candidate;
  }
  if (candidate === normalizedAnchor || candidate.endsWith(`.${normalizedAnchor}`)) {
    return candidate;
  }
  return `${candidate}.${normalizedAnchor}`;
};

export default function AddTargetModal({
  open,
  existingTargets = [],
  onAdd,
  onClose,
}: AddTargetModalProps) {
  const [value, setValue] = useState('');
  const [verificationMethod, setVerificationMethod] = useState<'dns_txt' | 'http_well_known'>('dns_txt');

  // Mounting, the portal, the escape key and the body scroll lock all belong to
  // `Modal` now — this file had its own copy of each.

  // Auto-detect type
  const type = useMemo(() => detectTargetType(value), [value]);
  const isDomain = type === 'domain';
  const isPrivateNetworkRange = !isDomain && isPrivateCidrLike(value);
  const existingDomainAnchor = useMemo(
    () =>
      existingTargets
        .filter((target) => target.type === 'domain')
        .sort((left, right) => left.value.split('.').length - right.value.split('.').length)[0] ?? null,
    [existingTargets],
  );
  const existingDomainAnchorValue = existingDomainAnchor?.value ?? null;
  const isAnchoredDomainInput = Boolean(existingDomainAnchorValue && isDomain);
  const isSubdomainBlockedUntilParentVerified = Boolean(
    isAnchoredDomainInput &&
    existingDomainAnchor &&
    existingDomainAnchor.verified !== true,
  );
  const submittedValue = useMemo(
    () =>
      isAnchoredDomainInput && existingDomainAnchorValue
        ? buildAnchoredDomainTargetValue(value, existingDomainAnchorValue)
        : value.trim(),
    [existingDomainAnchorValue, isAnchoredDomainInput, value],
  );

  const resetState = () => {
    setValue('');
    setVerificationMethod('dns_txt');
  };

  const handleAdd = () => {
    if (!submittedValue) return;
    if (isSubdomainBlockedUntilParentVerified) return;
    onAdd({
      type,
      value: submittedValue,
      verificationMethod: isDomain ? verificationMethod : 'manual_review',
    });
    resetState();
    onClose();
  };

  if (!open) return null;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Add target"
      size="md"
    >
      <ModalContent className="space-y-8 p-8">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Add a subdomain under this scope's domain boundary, or a network range. Nothing changes
          until you save the scope.
        </p>
          <div className="space-y-8">
            {/* Target Input */}
            <div className="space-y-3">
              <label className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80 font-bold">
                <span>Asset Identifier</span>
                {value.trim().length > 0 && (
                  <span className={cn(
                    "text-primary flex items-center gap-1.5 animate-in fade-in zoom-in-95 duration-200",
                    isDomain ? "text-primary" : "text-primary/70"
                  )}>
                    <ChevronRight className="h-3 w-3" />
                    {isDomain ? 'Domain Detected' : 'Network Range Detected'}
                  </span>
                )}
              </label>
              
              <div className="group relative">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 transition-colors group-focus-within:text-primary text-muted-foreground/60">
                   {isDomain ? <Globe className="h-5 w-5" /> : <Network className="h-5 w-5" />}
                </div>
                <Input
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={existingDomainAnchorValue ? 'api, admin, staging, or 192.168.1.0/24' : 'e.g. adu.ac.ae or 192.168.1.0/24'}
                  className={cn(
                    'pl-12 h-14 font-mono text-[15px] border-border/40 bg-surface-1/40 hover:bg-surface-1/60 focus:bg-background/50 focus:border-primary/50 transition-all',
                    isAnchoredDomainInput && 'pr-40',
                  )}
                  autoFocus
                />
                {isAnchoredDomainInput && existingDomainAnchorValue ? (
                  <div className="pointer-events-none absolute right-4 top-1/2 max-w-[42%] -translate-y-1/2 truncate border-l border-border/50 pl-3 font-mono text-[13px] font-bold text-muted-foreground/70">
                    .{existingDomainAnchorValue}
                  </div>
                ) : null}
              </div>
              {isAnchoredDomainInput && existingDomainAnchorValue ? (
                <div className="border border-border/50 bg-muted/10 px-4 py-3">
                  <p className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground/80">
                    Domain boundary: {existingDomainAnchorValue}
                  </p>
                  {isSubdomainBlockedUntilParentVerified ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-warning">
                      Verify {existingDomainAnchorValue} before adding subdomains under it.
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      Type only the subdomain prefix. This will add {submittedValue || `a subdomain of ${existingDomainAnchorValue}`}.
                      Use a separate scope for another company or unrelated root domain.
                    </p>
                  )}
                </div>
              ) : null}
            </div>

            {/* Verification Methodology */}
            {isDomain && value.trim().length > 0 && (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-3 duration-500">
                <div className="space-y-3">
                   <label className="block font-mono text-[10px] uppercase tracking-widest text-muted-foreground/80 font-bold">
                    Validation Protocol
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {([
                      { id: 'dns_txt', label: 'DNS TXT', desc: 'Add token to DNS' },
                      { id: 'http_well_known', label: 'Web Path', desc: 'Host a .txt file' }
                    ] as const).map((m) => {
                      const active = verificationMethod === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setVerificationMethod(m.id)}
                          className={cn(
                            "flex flex-col items-start p-4 border text-left transition-all relative overflow-hidden group",
                            active
                              ? "border-primary/40 bg-primary/5"
                              : "border-border/40 bg-surface-1/20 hover:border-border/80 hover:bg-surface-1/40"
                          )}
                        >
                          {active && (
                            <div className="absolute top-0 right-0 p-2 text-primary">
                              <div className="h-1.5 w-1.5 bg-primary" />
                            </div>
                          )}
                          <span className={cn(
                            "text-xs font-bold uppercase tracking-widest mb-1 font-mono",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )}>
                            {m.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground font-mono opacity-60">
                            {m.desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

              </div>
            )}

            {/* Network Range Notice */}
            {!isDomain && value.trim().length > 0 && (
              <div className="p-5 border border-primary/20 bg-primary/[0.03] space-y-3 animate-in fade-in slide-in-from-top-3 duration-500">
                <div className="flex items-center gap-2 text-primary/80">
                   <AlertCircle className="h-4 w-4" />
                   <span className="text-[10px] font-mono font-bold uppercase tracking-widest">
                    {isPrivateNetworkRange ? 'Private Runner Required' : 'Operator Review Pending'}
                   </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed font-mono opacity-80">
                  {isPrivateNetworkRange
                    ? 'Private ranges do not use internet ownership proof. They are authorized only for an attached private runner; running from this computer is blocked.'
                    : 'Public network ranges are reviewed by an operator before any run uses them.'}
                </p>
              </div>
            )}

          </div>

      </ModalContent>

      <ModalFooter>
        <Button
          variant="outline"
          onClick={() => {
            resetState();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button
          onClick={handleAdd}
          disabled={!value.trim() || isSubdomainBlockedUntilParentVerified}
        >
          Add target
        </Button>
      </ModalFooter>
    </Modal>
  );
}
