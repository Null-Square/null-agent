import { useState } from 'react';
import {
  Button,
  ListEmptyState,
  ListMeta,
  RecordTable,
  StatusPill,
  type StatusTone,
} from '@null-ai/design-tokens/ui';
import { TimeAgo } from '@shared/ui/TimeAgo';
import AddTargetModal from './AddTargetModal';
import TargetVerificationModal from './TargetVerificationModal';
import {
  useAutoVerifyTargetMutation,
  type ScopeTarget,
} from '@/modules/security-ops/api';
import type { PendingTarget } from '@/modules/scopes/model/scopeDraft';
import { isScopeAutoVerifyEnabled } from '@/modules/scopes/lib/autoVerify';

export type TargetRow = ScopeTarget | (PendingTarget & { pending: true });

interface TargetsListProps {
  /** Server targets minus staged removals, plus staged additions. */
  targets: TargetRow[];
  /** Ids the draft will delete on Save, shown so they can be put back. */
  removedTargets: ScopeTarget[];
  scopeId: string;
  canManage: boolean;
  onAdd: (target: Omit<PendingTarget, 'key'>) => void;
  onRemove: (target: TargetRow) => void;
  onRestore: (targetId: string) => void;
}

const normalizeDomain = (value: string): string => value.trim().toLowerCase().replace(/\.$/, '');

const isStrictSubdomain = (candidate: string, parent: string): boolean => {
  const normalizedCandidate = normalizeDomain(candidate);
  const normalizedParent = normalizeDomain(parent);
  return normalizedCandidate.length > normalizedParent.length && normalizedCandidate.endsWith(`.${normalizedParent}`);
};

const isPending = (target: TargetRow): target is PendingTarget & { pending: true } =>
  'pending' in target && target.pending === true;

const rowKey = (target: TargetRow): string => (isPending(target) ? target.key : target.id);

export default function TargetsList({
  targets,
  removedTargets,
  scopeId,
  canManage,
  onAdd,
  onRemove,
  onRestore,
}: TargetsListProps) {
  const autoVerifyEnabled = isScopeAutoVerifyEnabled();
  const savedTargets = targets.filter((target): target is ScopeTarget => !isPending(target));
  const verifiedTargetCount = savedTargets.filter((target) => target.verified).length;
  const pendingTargetCount = savedTargets.length - verifiedTargetCount;
  const [showAddTarget, setShowAddTarget] = useState(false);
  const [verifyingTarget, setVerifyingTarget] = useState<ScopeTarget | null>(null);

  /* Verification still writes immediately: proving control of a domain is not a
     boundary change, and holding a DNS check in a draft would mean the customer
     could not see whether the record they just published was found. */
  const autoVerifyTarget = useAutoVerifyTargetMutation();

  const getParentDomainTarget = (target: TargetRow): TargetRow | null => {
    if (target.type !== 'domain') return null;
    const parentTargets = targets
      .filter((candidate) => candidate.type === 'domain' && rowKey(candidate) !== rowKey(target))
      .filter((candidate) => isStrictSubdomain(target.value, candidate.value))
      .sort((left, right) => right.value.length - left.value.length);
    return parentTargets[0] ?? null;
  };

  const getVerificationActionLabel = (target: ScopeTarget) =>
    target.verificationMethod === 'http_well_known' ? 'Verify HTTP' : 'Verify DNS';

  // Verification state is lifecycle, so it is the shared pill — not a third
  // badge language with its own amber/blue palette.
  const verificationState = (target: TargetRow): { label: string; tone: StatusTone } => {
    if (isPending(target)) return { label: 'Unsaved', tone: 'signal' };
    if (target.verified) return { label: 'Verified', tone: 'success' };
    if (target.verificationMethod === 'manual_review') return { label: 'Pending review', tone: 'warning' };
    return { label: 'Pending', tone: 'warning' };
  };

  const summaryLine = () => {
    if (targets.length === 0) {
      return 'Add a domain or network range. A domain includes the apex and every descendant subdomain by default.';
    }
    if (savedTargets.length === 0) return 'Save the scope to add these targets.';
    if (pendingTargetCount > 0) return `${pendingTargetCount} of ${savedTargets.length} pending verification or review.`;
    return `All ${verifiedTargetCount} verified and ready for runs.`;
  };

  return (
    <div className="flex flex-col gap-5">
      {/* No sub-heading here: the panel above is already called "Targets &
          execution", so a "Targets" heading plus a "Target" column header would
          be the same noun three times down one column. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-sm text-muted-foreground">{summaryLine()}</p>
        {canManage ? (
          <Button variant="outline" className="shrink-0" onClick={() => setShowAddTarget(true)}>
            Add target
          </Button>
        ) : (
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Read only
          </span>
        )}
      </div>

      {targets.length === 0 ? (
        <ListEmptyState
          className="border-0"
          icon="domain"
          title="No targets configured"
          description="Add and verify a root. A verified domain covers the apex and all descendant subdomains; redirects, CNAMEs and shared IPs do not expand that boundary."
        />
      ) : (
        <RecordTable
          rows={targets}
          getRowKey={rowKey}
          hideHeader
          title={(target) => target.value}
          subtitle={(target) => {
            const parentTarget = getParentDomainTarget(target);
            return (
              <ListMeta
                items={[
                  parentTarget ? 'Subdomain' : target.type,
                  parentTarget ? `under ${parentTarget.value}` : null,
                  isPending(target) ? 'Added on save' : null,
                  !isPending(target) && !target.verified && target.verificationMethod === 'manual_review'
                    ? 'Awaiting admin review'
                    : null,
                  !isPending(target) && target.verifiedAt ? <TimeAgo key="at" date={target.verifiedAt} /> : null,
                ]}
              />
            );
          }}
          columns={[
            {
              key: 'state',
              header: 'Verification',
              width: '170px',
              render: (target) => {
                const state = verificationState(target);
                return <StatusPill tone={state.tone}>{state.label}</StatusPill>;
              },
              showOnMobile: true,
            },
          ]}
          actions={
            canManage
              ? (target) => (
                  <>
                    {!isPending(target) && !target.verified && target.type === 'domain' ? (
                      <Button size="sm" variant="outline" onClick={() => setVerifyingTarget(target)}>
                        {getVerificationActionLabel(target)}
                      </Button>
                    ) : null}
                    {!isPending(target) && !target.verified && autoVerifyEnabled ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={autoVerifyTarget.isPending}
                        onClick={() => autoVerifyTarget.mutate({ scopeId, targetId: target.id })}
                      >
                        Dev verify
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => onRemove(target)}
                    >
                      {isPending(target) ? 'Discard' : 'Delete'}
                    </Button>
                  </>
                )
              : undefined
          }
        />
      )}

      {/* A removal is a staged change like any other, so it stays visible and
          reversible until Save rather than vanishing on click. */}
      {removedTargets.length > 0 ? (
        <div className="divide-y divide-border border border-border">
          {removedTargets.map((target) => (
            <div key={target.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground line-through">
                {target.value}
              </span>
              <div className="flex shrink-0 items-center gap-3">
                <StatusPill tone="warning" showDot={false}>
                  Removed on save
                </StatusPill>
                <Button size="sm" variant="ghost" onClick={() => onRestore(target.id)}>
                  Undo
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <AddTargetModal
        open={showAddTarget}
        existingTargets={targets}
        onAdd={onAdd}
        onClose={() => setShowAddTarget(false)}
      />

      <TargetVerificationModal
        open={!!verifyingTarget}
        target={verifyingTarget}
        scopeId={scopeId}
        onClose={() => setVerifyingTarget(null)}
      />
    </div>
  );
}
