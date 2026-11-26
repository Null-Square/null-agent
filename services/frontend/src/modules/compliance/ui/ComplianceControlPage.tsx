import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Download,
  FileText,
  ShieldCheck,
  Upload,
  UserRound,
  Wrench,
} from 'lucide-react';

import {
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailSection,
  PendingNote,
  StatusPill,
  StatusTabs,
  type StatusTone,
} from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import {
  downloadComplianceEvidenceFile,
  useComplianceControlHistoryQuery,
  useComplianceEvidenceQuery,
  useFulfillComplianceControlRequestMutation,
  useOrganizationMembersQuery,
  useComplianceReadinessQuery,
  useUpdateComplianceControlStateMutation,
} from '@/modules/security-ops/api';
import type {
  ComplianceControlCheckBasis,
  ComplianceControlMonitoringState,
  ComplianceControlOutcome,
  ComplianceControlRequestPriority,
  ComplianceControlRequestStatus,
  ComplianceControlRequestType,
  ComplianceEvidenceItem,
  ComplianceEvidenceMapping,
  ComplianceFrameworkKey,
  ComplianceReadinessControl,
} from '@/modules/security-ops/types';

import { EvidenceUploadModal } from './EvidenceUploadModal';

const basisLabel: Record<ComplianceControlCheckBasis, string> = {
  agent_tested: 'Agent tested',
  agent_reviewed_user_evidence: 'Agent reviewed uploaded evidence',
  agent_reviewed_integration: 'Agent reviewed integration evidence',
};

const monitoringLabel: Record<ComplianceControlMonitoringState, string> = {
  monitored: 'Monitored',
  excluded: 'Excluded',
};

const implementationSpecLabel: Record<NonNullable<ComplianceReadinessControl['implementationSpec']>, string> = {
  required: 'Required implementation specification',
  addressable: 'Addressable implementation specification',
  mixed: 'Mixed required/addressable standard',
};

const pciApproachLabel: Record<NonNullable<ComplianceReadinessControl['pciDssApproach']>, string> = {
  defined: 'Defined approach',
  customized_eligible: 'Customized approach eligible',
  compensating_possible: 'Compensating control possible',
};

const pciCdeScopeLabel: Record<NonNullable<ComplianceReadinessControl['pciDssCdeScope']>, string> = {
  cde: 'CDE',
  connected_to: 'Connected-to',
  security_impacting: 'Security-impacting',
  payment_page: 'Payment page',
  program: 'Program',
};

const pciAccountDataLabel: Record<NonNullable<ComplianceReadinessControl['pciDssAccountData']>, string> = {
  chd: 'Cardholder data',
  sad: 'Sensitive authentication data',
  pan: 'PAN',
  none: 'No account data',
};

const outcomeLabel: Record<ComplianceControlOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  needs_action: 'Needs action',
  not_checked: 'Not checked',
  excluded: 'Excluded',
};

// A lifecycle state is a word graded by colour — the tinted, framed, icon-led
// pill this replaces was three devices for one fact.
const OUTCOME_TONE: Record<ComplianceControlOutcome, StatusTone> = {
  passed: 'success',
  failed: 'destructive',
  needs_action: 'warning',
  not_checked: 'neutral',
  excluded: 'neutral',
};

const requestTypeLabel: Record<ComplianceControlRequestType, string> = {
  evidence: 'Evidence',
  access: 'Access',
  context: 'Context',
  remediation: 'Remediation',
};

const priorityTone: Record<ComplianceControlRequestPriority, string> = {
  high: 'text-destructive',
  medium: 'text-warning',
  low: 'text-muted-foreground',
};

const requestStatusLabel: Record<ComplianceControlRequestStatus, string> = {
  open: 'Open',
  fulfilled: 'Awaiting agent review',
  reviewed: 'Reviewed',
  insufficient: 'Insufficient',
  contradicted: 'Contradicted',
  cancelled: 'Cancelled',
};

const requestStatusTone: Record<ComplianceControlRequestStatus, string> = {
  open: 'text-warning',
  fulfilled: 'text-info',
  reviewed: 'text-success',
  insufficient: 'text-warning',
  contradicted: 'text-destructive',
  cancelled: 'text-muted-foreground',
};

const isActionableRequestStatus = (status: ComplianceControlRequestStatus): boolean =>
  status === 'open' || status === 'fulfilled' || status === 'insufficient' || status === 'contradicted';

const evidenceStatusView = (item: ComplianceEvidenceItem): { label: string; className: string } => {
  if (item.agentReview?.status === 'reviewed') {
    return { label: 'Agent reviewed', className: 'text-success' };
  }
  if (item.agentReview?.status === 'needs_more_evidence') {
    return { label: 'More evidence needed', className: 'text-warning' };
  }
  if (item.status === 'unreviewed') {
    return { label: 'Awaiting agent review', className: 'text-muted-foreground' };
  }
  return { label: 'Expired', className: 'text-muted-foreground' };
};

const checkReviewLabel: Record<string, string> = {
  confirmed: 'Operator confirmed',
  rejected: 'Operator rejected',
  retest_required: 'Retest required',
};

const normalizeControlId = (value: string | undefined): string => decodeURIComponent(value ?? '').trim().toUpperCase();

const evidenceMatchesControl = (
  item: ComplianceEvidenceItem,
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): boolean =>
  item.mappings.some(
    (mapping) =>
      mapping.frameworkKey === frameworkKey &&
      mapping.controlId.trim().toUpperCase() === controlId.toUpperCase(),
  );

const evidenceMappingForControl = (
  item: ComplianceEvidenceItem,
  frameworkKey: ComplianceFrameworkKey,
  controlId: string,
): ComplianceEvidenceMapping | null =>
  item.mappings.find(
    (mapping) =>
      mapping.frameworkKey === frameworkKey &&
      mapping.controlId.trim().toUpperCase() === controlId.toUpperCase(),
  ) ?? null;

const mappingStatusLabel: Record<ComplianceEvidenceMapping['mappingSource'], string> = {
  user_declared: 'User mapped',
  system_suggested: 'Suggested',
};

const mappingStatusTone: Record<ComplianceEvidenceMapping['mappingSource'], string> = {
  user_declared: 'text-info',
  system_suggested: 'text-warning',
};

function EvidenceCard({ item, mapping }: { item: ComplianceEvidenceItem; mapping: ComplianceEvidenceMapping | null }) {
  const status = evidenceStatusView(item);
  return (
    <article className="border-b border-border/60 pb-5 last:border-b-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
              {item.sourceType.replace(/_/g, ' ')}
            </span>
            <span className={`text-[10px] font-bold uppercase tracking-widest ${status.className}`}>
              {status.label}
            </span>
            {mapping ? (
              <span className={`text-[10px] font-bold uppercase tracking-widest ${mappingStatusTone[mapping.mappingSource]}`}>
                {mappingStatusLabel[mapping.mappingSource]}
              </span>
            ) : null}
          </div>
          <h3 className="mt-3 text-sm font-semibold text-foreground">{item.title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {item.description || 'No description provided.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>Added {new Date(item.createdAt).toLocaleDateString()}</span>
            {item.validUntil ? <span>Valid until {new Date(item.validUntil).toLocaleDateString()}</span> : null}
            {item.agentReview?.reviewedAt ? <span>Agent reviewed {new Date(item.agentReview.reviewedAt).toLocaleDateString()}</span> : null}
            {item.artifact?.sha256 ? <span className="font-mono">sha256 {item.artifact.sha256.slice(0, 10)}...</span> : null}
          </div>
          {mapping?.rationale ? (
            <p className="mt-3 border-l-2 border-border pl-3 text-xs leading-5 text-muted-foreground">
              {mapping.rationale}
            </p>
          ) : null}
        </div>
        {item.artifact?.fileName ? (
          <button
            type="button"
            onClick={() => {
              void downloadComplianceEvidenceFile(item.id, item.artifact.fileName!);
            }}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-none border border-border px-3 text-[10px] font-bold uppercase tracking-widest text-foreground hover:border-foreground/40"
          >
            <Download className="h-3.5 w-3.5" />
            File
          </button>
        ) : null}
      </div>
    </article>
  );
}

function DetailText({ value, fallback }: { value: string | null | undefined; fallback?: string }) {
  return (
    <p className="max-w-[72ch] text-[15px] leading-8 text-foreground">
      {value?.trim() ? value : <span className="text-muted-foreground">{fallback ?? 'Not provided.'}</span>}
    </p>
  );
}

function DefinitionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-4 py-4">
      <div className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function ComplianceControlPage() {
  const { frameworkKey: rawFrameworkKey, controlId: rawControlId } = useParams();
  const frameworkKey = (rawFrameworkKey ?? 'soc2') as ComplianceFrameworkKey;
  const controlId = normalizeControlId(rawControlId);
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { activeScopeId } = useScope();
  const readinessQuery = useComplianceReadinessQuery(activeScopeId);
  const evidenceQuery = useComplianceEvidenceQuery(activeScopeId, frameworkKey, null, null, {
    enabled: Boolean(activeScopeId && frameworkKey),
  });
  const membersQuery = useOrganizationMembersQuery({ enabled: true });
  const historyQuery = useComplianceControlHistoryQuery(frameworkKey, controlId, {
    enabled: Boolean(controlId),
  });
  const updateControlState = useUpdateComplianceControlStateMutation();
  const fulfillControlRequest = useFulfillComplianceControlRequestMutation();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [fulfillRequestId, setFulfillRequestId] = useState('');
  const [activeTab, setActiveTab] = useState<'overview' | 'evidence' | 'remediation' | 'history'>('overview');
  const [monitoringState, setMonitoringState] = useState<ComplianceControlMonitoringState>('monitored');
  const [exclusionReason, setExclusionReason] = useState('');
  const [assignedToUserId, setAssignedToUserId] = useState('');
  const [managementError, setManagementError] = useState<string | null>(null);

  const framework = readinessQuery.data?.frameworks.find((item) => item.key === frameworkKey) ?? null;
  const control: ComplianceReadinessControl | null = useMemo(
    () => framework?.controls.find((item) => item.id.toUpperCase() === controlId) ?? null,
    [controlId, framework],
  );
  const latestCheck = control?.controlChecks[0] ?? null;
  const actionRequests = control?.actionRequests ?? [];
  const actionableRequests = actionRequests.filter((request) => isActionableRequestStatus(request.status));
  // Only surface the evidence-upload affordance when the agent has actually asked for a
  // document or access material — never as a default action.
  const uploadRequests = actionableRequests.filter(
    (request) =>
      (request.requestType === 'evidence' || request.requestType === 'access') &&
      request.status !== 'fulfilled',
  );
  const mappedEvidence = useMemo(
    () =>
      (evidenceQuery.data ?? []).filter((item) =>
        evidenceMatchesControl(item, frameworkKey, controlId),
      ),
    [controlId, evidenceQuery.data, frameworkKey],
  );
  const evidenceByMappingState = useMemo(() => {
    const groups = {
      userMapped: [] as Array<{ item: ComplianceEvidenceItem; mapping: ComplianceEvidenceMapping }>,
      suggested: [] as Array<{ item: ComplianceEvidenceItem; mapping: ComplianceEvidenceMapping }>,
    };
    for (const item of mappedEvidence) {
      const mapping = evidenceMappingForControl(item, frameworkKey, controlId);
      if (!mapping) continue;
      if (mapping.mappingSource === 'system_suggested') {
        groups.suggested.push({ item, mapping });
      } else {
        groups.userMapped.push({ item, mapping });
      }
    }
    return groups;
  }, [controlId, frameworkKey, mappedEvidence]);

  useEffect(() => {
    if (!control) return;
    setMonitoringState(control.monitoring.state);
    setExclusionReason(control.monitoring.exclusionReason ?? '');
    setAssignedToUserId(control.assignment.assignedToUserId ?? '');
    setManagementError(null);
  }, [control]);

  useEffect(() => {
    if (uploadRequests.length === 0) {
      setFulfillRequestId('');
      return;
    }
    if (!fulfillRequestId || !uploadRequests.some((request) => request.id === fulfillRequestId)) {
      setFulfillRequestId(uploadRequests[0]?.id ?? '');
    }
  }, [fulfillRequestId, uploadRequests]);

  if (readinessQuery.isLoading) {
    return (
      <PendingNote label="Reading this control" className="min-h-[calc(100vh-64px)]" />
    );
  }

  if (!framework || !control) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-64px)] max-w-3xl flex-col items-center justify-center p-6 text-center">
        <ShieldCheck className="mb-4 h-10 w-10 text-muted-foreground/50" />
        <h1 className="text-xl font-semibold text-foreground">Control not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The selected framework or control is not available for the active scope.
        </p>
        <button
          type="button"
          onClick={() => navigate(paths.compliance)}
          className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-none bg-primary px-4 text-[10px] font-bold uppercase tracking-widest text-primary-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to compliance
        </button>
      </div>
    );
  }


  // Auto-save: persist monitoring/owner changes as they happen (no manual save button).
  const persistState = (next: {
    state: ComplianceControlMonitoringState;
    exclusionReason: string;
    assignedToUserId: string;
  }) => {
    if (!activeScopeId) {
      setManagementError('Select a scope before changing control monitoring.');
      return;
    }
    // An excluded control needs a reason — wait for it rather than erroring on every keystroke.
    if (next.state === 'excluded' && next.exclusionReason.trim().length < 5) {
      return;
    }
    setManagementError(null);
    updateControlState.mutate({
      scopeId: activeScopeId,
      frameworkKey,
      controlId: control.id,
      state: next.state,
      exclusionReason: next.state === 'excluded' ? next.exclusionReason.trim() : null,
      // An excluded control has no owner — clear assignment so it never carries a stale owner.
      assignedToUserId: next.state === 'excluded' ? null : next.assignedToUserId || null,
    }, {
      onError: (error) => {
        const message = error instanceof Error ? error.message : 'Failed to update control.';
        setManagementError(message);
      },
    });
  };

  // The rail is the workflow: what the verdict rests on, how fresh it is, and
  // the evidence verb. The verdict itself is the header's first badge, so the
  // big tinted repeat of it at the top of the rail is gone.
  const rail = (
    <DetailRailBlock label="Verdict">
        <div>
          <dl className="mt-5 space-y-4 text-sm">
            <div>
              <dt className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Basis</dt>
              <dd className="mt-1 text-foreground">{control.basis ? basisLabel[control.basis] : 'No agent verdict yet'}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Freshness</dt>
              <dd className="mt-1 text-foreground">
                {control.evidenceFreshness.freshestAt
                  ? `Updated ${new Date(control.evidenceFreshness.freshestAt).toLocaleDateString()}`
                  : 'No dated evidence'}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Requests needing attention</dt>
              <dd className="mt-1 text-foreground">{actionableRequests.length}</dd>
            </div>
          </dl>
          {actionableRequests.length > 0 ? (
            <button
              type="button"
              onClick={() => setActiveTab('remediation')}
              className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-none border border-primary/40 bg-primary/10 px-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary/15"
            >
              <Wrench className="h-4 w-4" />
              View remediation
            </button>
          ) : null}
        </div>

        <div className="mt-6 border-t border-border/60 pt-5">
          <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            <UserRound className="h-4 w-4" />
            Monitoring
          </div>
          <div className="mt-4 grid gap-4">
            <div className="block">
              <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                State
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = monitoringState === 'monitored' ? 'excluded' : 'monitored';
                  setMonitoringState(next);
                  if (next === 'monitored') {
                    setExclusionReason('');
                    persistState({ state: 'monitored', exclusionReason: '', assignedToUserId });
                  }
                }}
                disabled={updateControlState.isPending}
                aria-pressed={monitoringState === 'monitored'}
                className={`inline-flex h-10 w-full items-center justify-between gap-2 rounded-none border px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  monitoringState === 'monitored'
                    ? 'border-success/40 bg-success/10 text-success hover:bg-success/15'
                    : 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/15'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <span className={`h-2 w-2 ${monitoringState === 'monitored' ? 'bg-success' : 'bg-warning'}`} />
                  {monitoringLabel[monitoringState]}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">
                  Tap to {monitoringState === 'monitored' ? 'exclude' : 'monitor'}
                </span>
              </button>
            </div>
            {monitoringState === 'excluded' ? (
              <label className="block">
                <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Exclusion reason
                </span>
                <textarea
                  value={exclusionReason}
                  onChange={(event) => setExclusionReason(event.target.value)}
                  onBlur={() => persistState({ state: monitoringState, exclusionReason, assignedToUserId })}
                  rows={3}
                  disabled={updateControlState.isPending}
                  className="w-full resize-none rounded-none border border-border/70 bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder="Why this control is not applicable to the selected scope (saved on blur)"
                />
              </label>
            ) : null}
            {monitoringState === 'excluded' ? null : (
              <label className="block">
                <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Owner
                </span>
                <select
                  value={assignedToUserId}
                  onChange={(event) => {
                    const value = event.target.value;
                    setAssignedToUserId(value);
                    persistState({ state: monitoringState, exclusionReason, assignedToUserId: value });
                  }}
                  disabled={updateControlState.isPending}
                  className="h-10 w-full rounded-none border border-border/70 bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Unassigned</option>
                  {(membersQuery.data ?? []).map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.fullName || member.email}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {managementError ? (
            <p className="mt-3 rounded-none border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {managementError}
            </p>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {updateControlState.isPending ? (
                <>
                  <span className="ns-live-mark h-[7px] w-[7px] flex-none bg-current" aria-hidden /> Saving
                </>
              ) : (
                'Changes save automatically.'
              )}
            </p>
          )}
        </div>
    </DetailRailBlock>
  );

  return (
    <DetailPageShell
      backLink={<DetailBackLink label="Back to Compliance" onClick={() => navigate(paths.compliance)} />}
      displayId={`${framework.label} · ${control.id}`}
      rail={rail}
    >
      <DetailHeader
        badges={
          <>
            <StatusPill tone={OUTCOME_TONE[control.outcome]}>
              {outcomeLabel[control.outcome]}
            </StatusPill>
            {control.basis ? (
              <StatusPill tone="neutral">{basisLabel[control.basis]}</StatusPill>
            ) : null}
          </>
        }
        title={control.title}
        subline={[
          framework.label,
          control.theme,
          control.catalogRef ? <span key="ref" className="font-mono">{control.catalogRef}</span> : null,
          control.implementationSpec ? implementationSpecLabel[control.implementationSpec] : null,
          control.pciDssRequirement ? `PCI Req ${control.pciDssRequirement}` : null,
          control.pciDssApproach ? pciApproachLabel[control.pciDssApproach] : null,
        ]}
      />

      {/* Same skeleton as the other detail pages; the rail's verb owns the
          page's one yellow, so the marker is bone. */}
      <StatusTabs
        className="mt-10"
        tone="bone"
        aria-label="Control sections"
        value={activeTab}
        onChange={(value) => setActiveTab(value as typeof activeTab)}
        itemAttributes={(item) => ({ 'data-tour': `control-tab-${item.value}` })}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'evidence', label: 'Evidence' },
          { value: 'remediation', label: 'Remediation' },
          { value: 'history', label: 'History' },
        ]}
      />

      <div className="mt-8 min-h-[400px]">
              {activeTab === 'overview' ? (
                <div className="animate-in space-y-10 fade-in duration-300">
                  <DetailSection label="What must be true">
                    <DetailText
                      value={control.proofObligation?.statement ?? control.gaps[0] ?? control.nextAction}
                      fallback="No proof obligation has been authored for this control yet."
                    />
                    {control.requiredEvidence.length > 0 ? (
                      <div className="mt-5 flex flex-wrap gap-2">
                        {control.requiredEvidence.map((item) => (
                          <span key={item} className="rounded-none border border-border/70 bg-surface-1/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                            {item}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </DetailSection>

                  <DetailSection label="Why this outcome">
                    <DetailText value={control.verdictReason} />
                    <div className="mt-6 divide-y divide-border/70 border-y border-border/70">
                      <DefinitionRow label="Reason code"><span className="font-mono text-xs">{control.reasonCode}</span></DefinitionRow>
                      <DefinitionRow label="Basis">
                        {control.basis ? basisLabel[control.basis] : <span className="text-muted-foreground">No agent verdict yet</span>}
                      </DefinitionRow>
                      <DefinitionRow label="Freshness">
                        {control.evidenceFreshness.freshestAt
                          ? `Updated ${new Date(control.evidenceFreshness.freshestAt).toLocaleDateString()}`
                          : <span className="text-muted-foreground">No dated evidence</span>}
                        {control.evidenceFreshness.stale ? <span className="ml-2 text-warning">(stale)</span> : null}
                      </DefinitionRow>
                    </div>
                  </DetailSection>

                  <DetailSection label="Control details">
                    <div className="divide-y divide-border/70 border-y border-border/70">
                      <DefinitionRow label="Framework">{framework.label}</DefinitionRow>
                      <DefinitionRow label="Theme">{control.theme}</DefinitionRow>
                      {control.implementationSpec ? (
                        <DefinitionRow label="Implementation spec">
                          {implementationSpecLabel[control.implementationSpec]}
                        </DefinitionRow>
                      ) : null}
                      {control.pciDssRequirement ? (
                        <DefinitionRow label="PCI requirement">
                          <span className="font-mono text-xs">{control.pciDssRequirement}</span>
                        </DefinitionRow>
                      ) : null}
                      {control.pciDssGoal ? (
                        <DefinitionRow label="PCI goal">{control.pciDssGoal}</DefinitionRow>
                      ) : null}
                      {control.pciDssApproach ? (
                        <DefinitionRow label="PCI approach">{pciApproachLabel[control.pciDssApproach]}</DefinitionRow>
                      ) : null}
                      {control.pciDssCdeScope ? (
                        <DefinitionRow label="PCI scope">{pciCdeScopeLabel[control.pciDssCdeScope]}</DefinitionRow>
                      ) : null}
                      {control.pciDssSaqTypes?.length ? (
                        <DefinitionRow label="Applicable SAQ">{control.pciDssSaqTypes.join(', ')}</DefinitionRow>
                      ) : null}
                      {control.pciDssAccountData && control.pciDssAccountData !== 'none' ? (
                        <DefinitionRow label="Account data">{pciAccountDataLabel[control.pciDssAccountData]}</DefinitionRow>
                      ) : null}
                      <DefinitionRow label="Catalog ref"><span className="font-mono text-xs">{control.catalogRef || '-'}</span></DefinitionRow>
                    </div>
                  </DetailSection>
                </div>
              ) : null}

              {activeTab === 'evidence' ? (
                <div className="animate-in space-y-10 fade-in duration-300">
                  <DetailSection label="Agent assessment">
                    {control.controlChecks.length > 0 ? (
                      <div className="space-y-4">
                        {control.controlChecks.map((check) => (
                          <article key={check.id} className="rounded-none border border-border/60 bg-background/60 p-5">
                            <div className="flex flex-wrap items-center gap-2.5">
                              <span className="inline-flex items-center rounded-none border border-border bg-surface-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-foreground">
                                {check.verdict.replace(/_/g, ' ')}
                              </span>
                              <span className="inline-flex items-center rounded-none text-[10px] font-medium text-primary">
                                {basisLabel[check.basis ?? 'agent_tested']}
                              </span>
                              <span className={`inline-flex items-center rounded-none border px-2.5 py-1 text-[10px] font-medium ${
                                check.eligible !== false ? 'text-success' : 'text-warning'
                              }`}>
                                {check.eligible !== false ? 'Eligible' : 'Not eligible'}
                              </span>
                              {check.reviewStatus && check.reviewStatus !== 'unreviewed' ? (
                                <span className="inline-flex items-center rounded-none border border-border/70 bg-muted/30 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
                                  {checkReviewLabel[check.reviewStatus] ?? check.reviewStatus.replace(/_/g, ' ')}
                                </span>
                              ) : null}
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {new Date(check.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <p className="mt-4 text-[15px] leading-7 text-foreground">{check.reason}</p>
                            <p className="mt-2 text-sm leading-7 text-muted-foreground">
                              <span className="font-semibold text-foreground">Proof:</span> {check.proof.claim}
                            </p>
                            <div className="mt-4 divide-y divide-border/60 border-t border-border/60">
                              <DefinitionRow label="Method">{check.method}</DefinitionRow>
                              <DefinitionRow label="Target"><span className="break-all font-mono text-xs">{check.targetRef}</span></DefinitionRow>
                              <DefinitionRow label="Replay">
                                {check.proof.replayReproduced
                                  ? 'Reproduced'
                                  : check.proof.replayAttempted
                                    ? 'Attempted'
                                    : `Not replayed${check.proof.notReplayedReason ? ` (${check.proof.notReplayedReason.replace(/_/g, ' ')})` : ''}`}
                              </DefinitionRow>
                              <DefinitionRow label="Artifacts">
                                {check.artifactIds.length} durable artifact{check.artifactIds.length !== 1 ? 's' : ''}; {check.evidenceRefs.length} evidence ref{check.evidenceRefs.length !== 1 ? 's' : ''}
                              </DefinitionRow>
                            </div>
                            {check.limitations.length > 0 ? (
                              <div className="mt-4 rounded-none border-l-2 border-border py-3 pl-4">
                                <div className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                                  Scope limitations
                                </div>
                                <ul className="space-y-1.5">
                                  {check.limitations.map((item) => (
                                    <li key={item} className="text-xs leading-5 text-muted-foreground">
                                      {item}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                            {check.latestReview ? (
                              <div className="mt-4 rounded-none border border-border/60 bg-background/70 p-3 text-xs leading-5 text-muted-foreground">
                                <span className="font-semibold text-foreground">Latest review:</span>{' '}
                                {check.latestReview.decision.replace(/_/g, ' ')} - {check.latestReview.note}
                              </div>
                            ) : null}
                            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                              {check.evidenceRefs.length ? (
                                <span className="inline-flex items-center gap-2 rounded-none border border-border/60 bg-surface-1/40 px-3 py-2 text-xs text-muted-foreground">
                                  <FileText className="h-3.5 w-3.5" />
                                  {check.evidenceRefs.length} evidence artifact{check.evidenceRefs.length !== 1 ? 's' : ''} captured
                                </span>
                              ) : <span />}
                              <button
                                type="button"
                                onClick={() => navigate(paths.runDetail(check.runId))}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary transition-colors hover:underline"
                              >
                                Open run
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-none border border-dashed border-border/70 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
                        The agent has not recorded a control check yet.
                      </div>
                    )}
                  </DetailSection>

                  <DetailSection label="Uploaded & integration evidence">
                    {mappedEvidence.length > 0 ? (
                      <div className="space-y-6">
                        {evidenceByMappingState.userMapped.length > 0 ? (
                          <div className="space-y-3">
                            <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest text-info">User-attached context</h3>
                            {evidenceByMappingState.userMapped.map(({ item, mapping }) => (
                              <EvidenceCard key={`${item.id}:${mapping.id}`} item={item} mapping={mapping} />
                            ))}
                          </div>
                        ) : null}
                        {evidenceByMappingState.suggested.length > 0 ? (
                          <div className="space-y-3">
                            <h3 className="font-mono text-[10px] font-bold uppercase tracking-widest text-warning">Suggested mappings</h3>
                            {evidenceByMappingState.suggested.map(({ item, mapping }) => (
                              <EvidenceCard key={`${item.id}:${mapping.id}`} item={item} mapping={mapping} />
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-none border border-dashed border-border/70 bg-muted/20 p-8 text-center text-sm text-muted-foreground">
                        No uploaded or integration evidence is mapped to this control yet.
                      </div>
                    )}
                  </DetailSection>
                </div>
              ) : null}

              {activeTab === 'remediation' ? (
                <div className="animate-in space-y-10 fade-in duration-300">
                  <DetailSection label="Recommendation">
                    <DetailText
                      value={control.nextAction}
                      fallback="No recommendation has been recorded for this control yet."
                    />
                  </DetailSection>

                  {actionRequests.length > 0 ? (
                    <DetailSection label="Agent action requests">
                      <div className="space-y-3">
                        {actionRequests.map((request) => (
                          <article key={request.id} className="rounded-none border border-border/60 bg-background/70 p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                                {requestTypeLabel[request.requestType]}
                              </span>
                              <span className={`text-[10px] font-bold uppercase tracking-widest ${priorityTone[request.priority]}`}>
                                {request.priority}
                              </span>
                              <span className={`text-[10px] font-bold uppercase tracking-widest ${requestStatusTone[request.status]}`}>
                                {requestStatusLabel[request.status]}
                              </span>
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {new Date(request.createdAt).toLocaleDateString()}
                              </span>
                            </div>
                            <h3 className="mt-3 text-sm font-semibold text-foreground">{request.title}</h3>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">{request.reason}</p>
                            {request.requestedEvidence.length > 0 ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {request.requestedEvidence.map((item) => (
                                  <span key={item} className="rounded-none border border-border/60 bg-surface-1/40 px-2.5 py-1.5 text-xs text-muted-foreground">
                                    {item}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {request.remediationHint ? (
                              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                <span className="font-semibold text-foreground">Remediation:</span> {request.remediationHint}
                              </p>
                            ) : null}
                            {request.fulfilledAt ? (
                              <p className="mt-3 rounded-none border border-success/25 bg-success/10 px-3 py-2 text-xs leading-5 text-success">
                                Fulfilled {new Date(request.fulfilledAt).toLocaleDateString()}
                                {request.fulfillmentEvidenceItemId
                                  ? ` with evidence ${request.fulfillmentEvidenceItemId.slice(0, 8)}`
                                  : ''}
                              </p>
                            ) : null}
                            {request.reviewedAt ? (
                              <div className="mt-3 rounded-none border border-border/60 bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
                                <div>
                                  <span className="font-semibold text-foreground">Review:</span>{' '}
                                  {requestStatusLabel[request.status]} on {new Date(request.reviewedAt).toLocaleDateString()}
                                  {request.reviewControlCheckId ? ` via check ${request.reviewControlCheckId.slice(0, 8)}` : ''}
                                </div>
                                {request.reviewNote ? <div className="mt-1">{request.reviewNote}</div> : null}
                                {request.nextReverificationAt ? (
                                  <div className="mt-1">
                                    Next re-verification {new Date(request.nextReverificationAt).toLocaleDateString()}
                                  </div>
                                ) : null}
                              </div>
                            ) : request.status === 'fulfilled' ? (
                              <p className="mt-3 rounded-none border border-info/25 bg-info/10 px-3 py-2 text-xs leading-5 text-info">
                                The uploaded evidence is waiting for the next compliance run to review it.
                              </p>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    </DetailSection>
                  ) : null}

                  {uploadRequests.length > 0 ? (
                    <DetailSection label="Provide evidence">
                      <p className="mb-3 max-w-[72ch] text-sm leading-7 text-muted-foreground">
                        Upload a document or export that satisfies the request above. The agent reviews it on the next
                        compliance run and updates the verdict.
                      </p>
                      <div className="max-w-[480px] space-y-3">
                        <label className="block">
                          <span className="mb-2 block font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                            Fulfill request
                          </span>
                          <select
                            value={fulfillRequestId}
                            onChange={(event) => setFulfillRequestId(event.target.value)}
                            className="h-10 w-full rounded-none border border-border/70 bg-background px-3 text-sm text-foreground outline-none transition-colors focus:border-primary"
                          >
                            {uploadRequests.map((request) => (
                              <option key={request.id} value={request.id}>
                                {request.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          data-tour="control-upload"
                          onClick={() => {
                            setUploadOpen(true);
                          }}
                          className="inline-flex h-10 items-center justify-center gap-2 rounded-none border border-primary/40 bg-primary/10 px-4 font-mono text-[10px] font-bold uppercase tracking-widest text-primary transition-colors hover:bg-primary/15"
                        >
                          <Upload className="h-4 w-4" />
                          Upload requested evidence
                        </button>
                      </div>
                    </DetailSection>
                  ) : null}

                  {control.gaps.length > 0 ? (
                    <DetailSection label="Open gaps">
                      <ul className="max-w-[72ch] space-y-3">
                        {control.gaps.map((gap) => (
                          <li key={gap} className="flex gap-3 text-sm leading-7 text-foreground">
                            <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-none bg-foreground/50" />
                            <span>{gap}</span>
                          </li>
                        ))}
                      </ul>
                    </DetailSection>
                  ) : null}

                  <DetailSection label="Limitations">
                    {latestCheck?.limitations.length || control.coverageLimitations.length ? (
                      <ul className="max-w-[72ch] space-y-3">
                        {[...(latestCheck?.limitations ?? []), ...control.coverageLimitations].map((item) => (
                          <li key={item} className="flex gap-3 text-sm leading-7 text-muted-foreground">
                            <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-none bg-muted-foreground/40" />
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="max-w-[72ch] text-sm leading-7 text-muted-foreground">
                        No limitations were recorded - the assessment covered the obligation within the tested scope.
                      </p>
                    )}
                  </DetailSection>
                </div>
              ) : null}

              {activeTab === 'history' ? (
                <DetailSection label="Change history">
                  {(historyQuery.data?.events ?? []).length === 0 ? (
                    <p className="py-8 text-center font-mono text-xs uppercase tracking-wider text-muted-foreground">
                      {historyQuery.isLoading ? 'Loading history…' : 'No monitoring or assignment changes recorded yet.'}
                    </p>
                  ) : (
                    <div className="space-y-0">
                      {(historyQuery.data?.events ?? []).map((event, index, list) => {
                        const actor = (membersQuery.data ?? []).find((member) => member.userId === event.actorId);
                        const actorName = actor?.fullName || actor?.email || (event.actorType === 'system' ? 'System' : 'A workspace member');
                        const owner = event.changes?.assignedToUserId
                          ? (membersQuery.data ?? []).find((member) => member.userId === event.changes?.assignedToUserId)
                          : null;
                        const stateText = event.changes?.state === 'excluded'
                          ? `Excluded${event.changes?.exclusionReason ? `: ${event.changes.exclusionReason}` : ''}`
                          : event.changes?.state === 'monitored'
                            ? 'Set to monitored'
                            : 'Updated control state';
                        const ownerText = event.changes?.state === 'excluded'
                          ? null
                          : owner
                            ? `Owner set to ${owner.fullName || owner.email}`
                            : event.changes?.assignedToUserId === null
                              ? 'Owner cleared'
                              : null;
                        return (
                          <div key={event.id} className="relative flex gap-4 pb-6 last:pb-0">
                            {index < list.length - 1 ? <div className="absolute left-[7px] top-4 h-full w-px bg-border" /> : null}
                            <div className="relative z-10 mt-1.5 h-[15px] w-[15px] shrink-0 border border-primary bg-background" />
                            <div className="flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
                                  {event.changes?.state === 'excluded' ? 'EXCLUDED' : event.changes?.state === 'monitored' ? 'MONITORED' : 'UPDATED'}
                                </span>
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {actorName} · {new Date(event.createdAt).toLocaleString()}
                                </span>
                              </div>
                              <p className="mt-1 font-mono text-xs text-muted-foreground">{stateText}</p>
                              {ownerText ? <p className="mt-1 font-mono text-xs text-muted-foreground">{ownerText}</p> : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </DetailSection>
              ) : null}
      </div>

      <EvidenceUploadModal
          isOpen={uploadOpen}
          onClose={() => setUploadOpen(false)}
          scopeId={activeScopeId}
          targetItem={{
            frameworkKey,
            frameworkLabel: framework.label,
            controlId: control.id,
            title: control.title,
            theme: control.theme,
            supportLevel: control.supportLevel,
            status: control.status,
            score: control.score,
            gap: control.gaps[0] ?? control.nextAction,
            mappedEvidenceCount: mappedEvidence.length,
            approvedEvidenceCount: mappedEvidence.filter((item) => item.agentReview?.status === 'reviewed').length,
            acceptedRiskCount: 0,
          }}
          onUploaded={(evidence) => {
            if (!fulfillRequestId) return;
            fulfillControlRequest.mutate({
              requestId: fulfillRequestId,
              evidenceItemId: evidence.id,
              note: 'Evidence uploaded from the control workspace.',
            });
          }}
        />
    </DetailPageShell>
  );
}
