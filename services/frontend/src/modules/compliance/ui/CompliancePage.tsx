import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';

import {
  Button,
  FacetSelect,
  ListEmptyState,
  ListMeta,
  ListMetrics,
  ListNotice,
  ListPageShell,
  ListSkeleton,
  Modal,
  ModalContent,
  ModalFooter,
  QueryBar,
  RecordTable,
  StatusPill,
  StatusTabs,
  Textarea,
  type StatusTone,
} from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import {
  useBulkUpdateComplianceControlStateMutation,
  useComplianceReadinessQuery,
} from '@/modules/security-ops/api';
import type {
  ComplianceControlMonitoringState,
  ComplianceControlOutcome,
  ComplianceFrameworkReadiness,
  ComplianceReadinessControl,
} from '@/modules/security-ops/types';
import { toastService } from '@shared/services/toastService';

import { EvidenceLibrary } from './EvidenceLibrary';
import { EvidenceUploadModal } from './EvidenceUploadModal';

const outcomeLabel: Record<ComplianceControlOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  needs_action: 'Needs action',
  not_checked: 'Not checked',
  excluded: 'Excluded',
};

// The five compliance outcomes are pills — the brand's one lifecycle shape. No
// per-outcome icon: colour plus the word already say it, and a glyph restating
// them is the redundancy the kit cut everywhere else.
const outcomeTone: Record<ComplianceControlOutcome, StatusTone> = {
  passed: 'success',
  failed: 'destructive',
  needs_action: 'warning',
  not_checked: 'neutral',
  excluded: 'neutral',
};

const OUTCOMES: ComplianceControlOutcome[] = ['passed', 'failed', 'needs_action', 'not_checked', 'excluded'];

const monitoringLabel: Record<ComplianceReadinessControl['monitoring']['state'], string> = {
  monitored: 'Monitored',
  excluded: 'Excluded',
};

const implementationSpecLabel: Record<NonNullable<ComplianceReadinessControl['implementationSpec']>, string> = {
  required: 'Required',
  addressable: 'Addressable',
  mixed: 'Mixed',
};

const pciApproachLabel: Record<NonNullable<ComplianceReadinessControl['pciDssApproach']>, string> = {
  defined: 'Defined',
  customized_eligible: 'Customized eligible',
  compensating_possible: 'Compensating possible',
};

const pciCdeScopeLabel: Record<NonNullable<ComplianceReadinessControl['pciDssCdeScope']>, string> = {
  cde: 'CDE',
  connected_to: 'Connected-to',
  security_impacting: 'Security-impacting',
  payment_page: 'Payment page',
  program: 'Program',
};

const pciAccountDataLabel: Record<NonNullable<ComplianceReadinessControl['pciDssAccountData']>, string> = {
  chd: 'CHD',
  sad: 'SAD',
  pan: 'PAN',
  none: 'No account data',
};

type PageMode = 'controls' | 'evidence';

const staticSupportActions = new Set([
  'Upload current customer evidence for review.',
  'Connect the required integration or upload a verified export.',
]);

const defaultMonitoringState = (control: ComplianceReadinessControl): ComplianceControlMonitoringState =>
  control.supportLevel === 'out_of_selected_scope' ? 'excluded' : 'monitored';

const isActionableRequestStatus = (status: ComplianceReadinessControl['actionRequests'][number]['status']): boolean =>
  status === 'open' || status === 'fulfilled' || status === 'insufficient' || status === 'contradicted';

const outcomeForVerdict = (
  verdict: ComplianceReadinessControl['verdict'],
  actionRequests: ComplianceReadinessControl['actionRequests'],
): ComplianceControlOutcome => {
  if (actionRequests.some((request) => isActionableRequestStatus(request.status))) return 'needs_action';
  if (verdict === 'pass') return 'passed';
  if (verdict === 'fail') return 'failed';
  if (verdict === 'not_applicable' || verdict === 'not_supported') return 'excluded';
  // needs_context/needs_evidence only arise from a real observation (an agent check or a stale prior
  // check), so they are genuine action items. An unobserved control is not_attempted -> not_checked.
  if (verdict === 'needs_context' || verdict === 'needs_evidence') return 'needs_action';
  return 'not_checked';
};

const legacyVerdictForControl = (
  control: ComplianceReadinessControl,
): ComplianceReadinessControl['verdict'] => {
  if (control.status === 'failing') return 'fail';
  if (control.status === 'accepted_risk') return 'accepted_risk';
  if (control.status === 'not_applicable') return 'not_applicable';
  if (control.status === 'not_supported') return 'not_supported';
  if (control.status === 'stale') return 'needs_evidence';
  // No observation: neutral. supportLevel only shapes the next-action hint, never the verdict.
  return 'not_attempted';
};

const fallbackNextAction = (
  control: ComplianceReadinessControl,
  verdict: ComplianceReadinessControl['verdict'],
): string => {
  const request = control.actionRequests.find((item) => isActionableRequestStatus(item.status));
  if (request) {
    if (request.status === 'fulfilled') return `${request.title}: fulfilled evidence is waiting for agent review.`;
    if (request.status === 'insufficient') return `${request.title}: the last review found the evidence insufficient.`;
    if (request.status === 'contradicted') return `${request.title}: the last review contradicted the expected control state.`;
    if (request.requestType === 'remediation' && request.remediationHint) return `${request.title}: ${request.remediationHint}`;
    return `${request.title}: ${request.reason}`;
  }
  if (verdict === 'fail') return 'Remediate the failed behavior, then run the control check again.';
  if (verdict === 'accepted_risk') return 'Review the accepted risk before its expiry date.';
  if (verdict === 'not_applicable') return 'No action is required for the selected scope.';
  if (verdict === 'not_supported') return 'Assess this control outside Null-AI.';
  if (verdict === 'needs_context') return 'Re-run the control after the agent opens or receives the missing context.';
  // Unobserved or stale: the expected verification method (supportLevel) shapes the hint only.
  if (control.supportLevel === 'manual_evidence_required') {
    return 'The agent will review supporting documents on the next compliance run, or request what is missing.';
  }
  if (control.supportLevel === 'integration_required') {
    return 'The agent will review connected integration exports on the next compliance run, or request access.';
  }
  return control.proofObligation
    ? 'The agent will run a targeted check for what must be true on the next compliance run.'
    : 'No agent request is open for this control yet.';
};

const normalizeControl = (control: ComplianceReadinessControl): ComplianceReadinessControl => {
  const verdict = control.verdict ?? legacyVerdictForControl(control);
  const evidence = Array.isArray(control.evidence) ? control.evidence : [];
  const actionRequests = Array.isArray(control.actionRequests) ? control.actionRequests : [];
  const proofObligation = control.proofObligation ?? null;
  const evidenceDates = evidence
    .map((item) => item.lastSeenAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  return {
    ...control,
    verdict,
    implementationSpec: control.implementationSpec ?? null,
    pciDssRequirement: control.pciDssRequirement ?? null,
    pciDssGoal: control.pciDssGoal ?? null,
    pciDssApproach: control.pciDssApproach ?? null,
    pciDssSaqTypes: Array.isArray(control.pciDssSaqTypes) ? control.pciDssSaqTypes : null,
    pciDssCdeScope: control.pciDssCdeScope ?? null,
    pciDssAccountData: control.pciDssAccountData ?? null,
    proofObligation,
    outcome: outcomeForVerdict(verdict, actionRequests),
    reasonCode: control.reasonCode ?? 'legacy_readiness',
    basis: control.basis ?? control.controlChecks?.[0]?.basis ?? null,
    verdictReason:
      control.verdictReason ??
      control.rationale ??
      'This control has not been evaluated with the current readiness model.',
    evidence,
    gaps: Array.isArray(control.gaps) ? control.gaps : [],
    coverageLimitations: Array.isArray(control.coverageLimitations) ? control.coverageLimitations : [],
    catalogRef: control.catalogRef ?? '',
    requiredEvidence: Array.isArray(control.requiredEvidence) ? control.requiredEvidence : [],
    nextAction: control.nextAction && !staticSupportActions.has(control.nextAction)
      ? control.nextAction
      : fallbackNextAction({ ...control, actionRequests, proofObligation } as ComplianceReadinessControl, verdict),
    evidenceFreshness: control.evidenceFreshness ?? {
      freshestAt: evidenceDates.at(-1) ?? null,
      stale: control.status === 'stale',
    },
    monitoring: control.monitoring ?? {
      state: defaultMonitoringState({ ...control, proofObligation } as ComplianceReadinessControl),
      source: 'default',
      exclusionReason: defaultMonitoringState({ ...control, proofObligation } as ComplianceReadinessControl) === 'excluded'
        ? 'Not in the agent-testable scope for this framework.'
        : null,
      updatedAt: null,
    },
    assignment: control.assignment ?? {
      assignedToUserId: null,
      assignedByUserId: null,
      assignedAt: null,
    },
    actionRequests,
    controlChecks: Array.isArray(control.controlChecks) ? control.controlChecks : [],
  };
};

const emptyOutcomeCounts = (): Record<ComplianceControlOutcome, number> => ({
  passed: 0,
  failed: 0,
  needs_action: 0,
  not_checked: 0,
  excluded: 0,
});

const normalizeFramework = (framework: ComplianceFrameworkReadiness): ComplianceFrameworkReadiness => {
  const controls = Array.isArray(framework.controls) ? framework.controls.map(normalizeControl) : [];
  const outcomeCounts = controls.reduce((counts, control) => {
    counts[control.outcome] += 1;
    return counts;
  }, emptyOutcomeCounts());

  return {
    ...framework,
    controls,
    outcomeCounts,
    verdictCounts: framework.verdictCounts ?? {
      pass: 0,
      fail: 0,
      needs_evidence: 0,
      needs_context: 0,
      not_attempted: 0,
      accepted_risk: 0,
      not_applicable: 0,
      not_supported: 0,
    },
    gaps: Array.isArray(framework.gaps) ? framework.gaps : [],
    coverageLimitations: Array.isArray(framework.coverageLimitations) ? framework.coverageLimitations : [],
  };
};

function FrameworkDashboard({ framework }: { framework: ComplianceFrameworkReadiness }) {
  const activeControls = framework.controls.filter((control) => control.monitoring.state === 'monitored');
  const checked = activeControls.filter((control) => (
    control.outcome === 'passed' ||
    control.outcome === 'failed' ||
    control.outcome === 'needs_action'
  )).length;
  const total = activeControls.length;
  const inactive = framework.controls.length - total;
  const latestCheckAt = framework.controls
    .flatMap((control) => control.controlChecks.map((check) => check.createdAt))
    .filter(Boolean)
    .sort()
    .at(-1);
  // Request pipeline: what needs the user vs what the agent will review next run.
  const allRequests = activeControls.flatMap((control) => control.actionRequests);
  const openRequests = allRequests.filter(
    (request) => request.status === 'open' || request.status === 'insufficient' || request.status === 'contradicted',
  ).length;
  const awaitingReview = allRequests.filter((request) => request.status === 'fulfilled').length;

  return (
    <div className="mb-8 space-y-3">
      <p className="text-sm leading-6 text-muted-foreground">
        {checked} of {total} monitored controls have an agent-readable outcome.
        {inactive > 0
          ? ` ${inactive} control${inactive === 1 ? ' is' : 's are'} not in the active readiness denominator.`
          : ''}
        {latestCheckAt ? ` Latest check ${new Date(latestCheckAt).toLocaleDateString()}.` : ' No agent check has been recorded yet.'}
      </p>

      {/* Only the two outcomes that ask for work carry colour. "Passed" stays
          quiet on purpose — the brand doc renders `38 / 38 controls passing`
          as a quiet cell, because good news does not need to shout. */}
      <ListMetrics
        items={OUTCOMES.map((outcome) => ({
          label: outcomeLabel[outcome],
          value: framework.outcomeCounts[outcome] ?? 0,
          severity:
            outcome === 'failed' ? ('critical' as const) : outcome === 'needs_action' ? ('high' as const) : undefined,
        }))}
      />

      {openRequests > 0 ? (
        <ListNotice
          tone="neutral"
          title={`${openRequests} open request${openRequests === 1 ? '' : 's'} need your input`}
          description={
            awaitingReview > 0
              ? `${awaitingReview} fulfilled · awaiting agent review.`
              : undefined
          }
        />
      ) : awaitingReview > 0 ? (
        <ListNotice tone="neutral" title={`${awaitingReview} fulfilled · awaiting agent review`} />
      ) : null}
    </div>
  );
}

function ControlList({
  controls,
  frameworkKey,
  onOpenControl,
  onUpdateControls,
  updateDisabled,
}: {
  controls: ComplianceReadinessControl[];
  frameworkKey: string;
  onOpenControl: (frameworkKey: string, controlId: string) => void;
  onUpdateControls: (controlIds: string[], state: ComplianceControlMonitoringState, label: string) => void;
  updateDisabled: boolean;
}) {
  // Groups are folded by default; track the explicitly expanded ones.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = (label: string) =>
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });

  if (controls.length === 0) {
    return (
      <ListEmptyState
        variant="filtered"
        icon="search"
        title="No controls match this query"
        description="Widen the monitoring lane or the outcome facet to bring controls back."
      />
    );
  }

  const groupedControls = controls.reduce<Array<{ label: string; controls: ComplianceReadinessControl[] }>>((groups, control) => {
    const label = control.theme || control.id.split('.')[0] || 'Other Controls';
    const existing = groups.find((group) => group.label === label);
    if (existing) {
      existing.controls.push(control);
    } else {
      groups.push({ label, controls: [control] });
    }
    return groups;
  }, []);

  // Compliance is the one nested list — controls live under a theme. The nesting
  // is a collapsible group header; everything below it is the same shared data
  // table every other list page renders, so the row grammar never diverges.
  return (
    <div>
      {groupedControls.map((group) => {
        const monitoredControls = group.controls.filter((control) => control.monitoring.state === 'monitored');
        const monitored = monitoredControls.length;
        const excluded = group.controls.length - monitored;
        const isCollapsed = !expandedGroups.has(group.label);
        const groupMetrics = OUTCOMES.filter((outcome) => outcome !== 'excluded')
          .map((outcome) => ({
            outcome,
            count: monitoredControls.filter((control) => control.outcome === outcome).length,
          }))
          .filter((metric) => metric.count > 0);

        return (
          <section key={group.label} className="border-b border-border/60 last:border-b-0">
            <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
              <button
                type="button"
                data-group-toggle="true"
                data-tour={group.controls.some((control) => control.outcome === 'needs_action') ? 'compliance-group-needs-action' : undefined}
                onClick={() => toggleGroup(group.label)}
                aria-expanded={!isCollapsed}
                className="flex flex-1 items-center gap-3 text-left"
              >
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-foreground">{group.label}</span>
                  <span className="mt-1 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                    {groupMetrics.length > 0
                      ? groupMetrics.map((metric) => `${metric.count} ${outcomeLabel[metric.outcome]}`).join(' · ')
                      : 'No monitored controls assessed yet.'}
                    {excluded > 0 ? ` · ${excluded} Excluded` : ''}
                  </span>
                </span>
              </button>
              <div className="flex flex-wrap gap-2">
                {excluded > 0 ? (
                  <Button size="sm" variant="outline" disabled={updateDisabled} onClick={() => onUpdateControls(group.controls.map((control) => control.id), 'monitored', group.label)}>
                    Monitor group
                  </Button>
                ) : null}
                {monitored > 0 ? (
                  <Button size="sm" variant="ghost" disabled={updateDisabled} onClick={() => onUpdateControls(group.controls.map((control) => control.id), 'excluded', group.label)}>
                    Exclude group
                  </Button>
                ) : null}
              </div>
            </div>

            {isCollapsed ? null : (
              <RecordTable
                rows={group.controls}
                getRowKey={(control) => control.id}
                titleHeader="Control"
                titleWidth="minmax(0,2fr)"
                title={(control) => control.title}
                subtitle={(control) => <ControlMeta control={control} />}
                rowActionLabel={(control) => `Open control ${control.id}: ${control.title}`}
                rowAttributes={(control) => ({
                  'data-tour': control.outcome === 'needs_action' ? 'compliance-control-needs-action' : undefined,
                })}
                rowClassName={(control) => (control.monitoring.state === 'excluded' ? 'opacity-75' : undefined)}
                onRowClick={(control) => onOpenControl(frameworkKey, control.id)}
                columns={[
                  {
                    key: 'outcome',
                    header: 'Outcome',
                    width: '150px',
                    render: (control) => (
                      <StatusPill tone={outcomeTone[control.outcome]}>{outcomeLabel[control.outcome]}</StatusPill>
                    ),
                    showOnMobile: true,
                  },
                  {
                    key: 'evidence',
                    header: 'Evidence',
                    width: '150px',
                    render: (control) => {
                      const latestCheck = control.controlChecks[0] ?? null;
                      const freshness = control.evidenceFreshness.stale
                        ? 'stale'
                        : latestCheck
                          ? `checked ${new Date(latestCheck.createdAt).toLocaleDateString()}`
                          : 'no check';
                      return (
                        <span className="block font-mono text-[11px] tabular-nums">
                          <span className="text-foreground">{control.evidence.length} mapped</span>
                          <span className={`mt-0.5 block ${control.evidenceFreshness.stale ? 'text-warning' : 'text-muted-foreground'}`}>
                            {freshness}
                          </span>
                        </span>
                      );
                    },
                  },
                ]}
                actions={(control) => (
                  <Button
                    size="sm"
                    variant={control.monitoring.state === 'monitored' ? 'ghost' : 'outline'}
                    disabled={updateDisabled}
                    onClick={() =>
                      onUpdateControls(
                        [control.id],
                        control.monitoring.state === 'monitored' ? 'excluded' : 'monitored',
                        control.title,
                      )
                    }
                  >
                    {control.monitoring.state === 'monitored' ? 'Exclude' : 'Monitor'}
                  </Button>
                )}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * The control's identifiers and framework metadata, set as one quiet mono line
 * rather than the wall of bordered chips this row used to carry. Each value
 * stays its own element so it can still be read (and asserted) individually.
 */
function ControlMeta({ control }: { control: ComplianceReadinessControl }) {
  return (
    <span className="block">
      <ListMeta
        items={[
          control.id,
          monitoringLabel[control.monitoring.state],
          control.implementationSpec ? implementationSpecLabel[control.implementationSpec] : null,
          control.pciDssRequirement ? `Req ${control.pciDssRequirement}` : null,
          control.pciDssApproach ? pciApproachLabel[control.pciDssApproach] : null,
          control.pciDssCdeScope ? pciCdeScopeLabel[control.pciDssCdeScope] : null,
          control.pciDssAccountData && control.pciDssAccountData !== 'none'
            ? pciAccountDataLabel[control.pciDssAccountData]
            : null,
        ]}
      />
      <span className="mt-1.5 line-clamp-2 block whitespace-normal text-[13px] leading-5 text-muted-foreground">
        {control.verdictReason}
      </span>
      {control.monitoring.state === 'excluded' && control.monitoring.exclusionReason ? (
        <span className="mt-1 line-clamp-1 block whitespace-normal text-xs text-muted-foreground">
          Exclusion: {control.monitoring.exclusionReason}
        </span>
      ) : null}
    </span>
  );
}

export default function CompliancePage({ initialPageMode }: { initialPageMode?: PageMode } = {}) {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { activeScopeId } = useScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const [viewFilter, setViewFilter] = useState<'monitored' | 'needs_action' | 'excluded'>('monitored');
  const [statusFilter, setStatusFilter] = useState<'all' | ComplianceControlOutcome>('all');
  const [search, setSearch] = useState('');
  const [pageMode, setPageMode] = useState<PageMode>(initialPageMode ?? 'controls');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<{
    controlIds: string[];
    state: ComplianceControlMonitoringState;
    label: string;
  } | null>(null);
  const [bulkReason, setBulkReason] = useState('');

  const { data: readiness, isLoading } = useComplianceReadinessQuery(activeScopeId);
  const bulkUpdateControlState = useBulkUpdateComplianceControlStateMutation();
  const frameworks = useMemo(
    () => (readiness?.frameworks ?? []).map(normalizeFramework),
    [readiness?.frameworks],
  );
  const selectedFrameworkKey = searchParams.get('framework') ?? frameworks.find((item) => item.selected)?.key ?? frameworks[0]?.key;
  const selectedFramework = frameworks.find((item) => item.key === selectedFrameworkKey) ?? frameworks[0] ?? null;

  const filteredControls = useMemo(() => {
    if (!selectedFramework) return [];
    const query = search.trim().toLowerCase();
    return selectedFramework.controls
      .filter((control) => {
        if (viewFilter === 'excluded') return control.monitoring.state === 'excluded';
        if (control.monitoring.state !== 'monitored') return false;
        if (viewFilter === 'needs_action') return control.outcome === 'needs_action';
        return true;
      })
      .filter((control) => statusFilter === 'all' || control.outcome === statusFilter)
      .filter((control) => {
        if (!query) return true;
        return [
          control.id,
          control.title,
          control.theme,
          control.implementationSpec ?? '',
          control.pciDssRequirement ?? '',
          control.pciDssGoal ?? '',
          control.pciDssApproach ?? '',
          control.pciDssCdeScope ?? '',
          control.pciDssAccountData ?? '',
          ...(control.pciDssSaqTypes ?? []),
          control.verdictReason,
          control.nextAction,
          ...control.gaps,
          ...control.requiredEvidence,
        ].join(' ').toLowerCase().includes(query);
      });
  }, [viewFilter, statusFilter, search, selectedFramework]);

  const selectFramework = (frameworkKey: string) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('framework', frameworkKey);
    setSearchParams(nextParams, { replace: true });
  };

  const requestControlStateChange = (
    controlIds: string[],
    state: ComplianceControlMonitoringState,
    label: string,
  ) => {
    if (!activeScopeId || !selectedFramework) {
      toastService.error('Select a scope and framework before changing controls.');
      return;
    }
    const uniqueControlIds = Array.from(new Set(controlIds));
    if (state === 'excluded') {
      setBulkAction({ controlIds: uniqueControlIds, state, label });
      setBulkReason('');
      return;
    }
    bulkUpdateControlState.mutate({
      scopeId: activeScopeId,
      frameworkKey: selectedFramework.key,
      controlIds: uniqueControlIds,
      state,
      exclusionReason: null,
    }, {
      onSuccess: () => toastService.success(`${uniqueControlIds.length} control${uniqueControlIds.length === 1 ? '' : 's'} monitored.`),
      onError: (error) => toastService.error(error instanceof Error ? error.message : 'Failed to update controls.'),
    });
  };

  const submitBulkAction = () => {
    if (!bulkAction || !activeScopeId || !selectedFramework) return;
    if (bulkAction.state === 'excluded' && bulkReason.trim().length < 5) {
      toastService.error('Add a short exclusion reason.');
      return;
    }
    bulkUpdateControlState.mutate({
      scopeId: activeScopeId,
      frameworkKey: selectedFramework.key,
      controlIds: bulkAction.controlIds,
      state: bulkAction.state,
      exclusionReason: bulkAction.state === 'excluded' ? bulkReason.trim() : null,
    }, {
      onSuccess: () => {
        toastService.success(`${bulkAction.controlIds.length} control${bulkAction.controlIds.length === 1 ? '' : 's'} excluded.`);
        setBulkAction(null);
        setBulkReason('');
      },
      onError: (error) => toastService.error(error instanceof Error ? error.message : 'Failed to update controls.'),
    });
  };

  const monitoredControls = selectedFramework?.controls.filter((c) => c.monitoring.state === 'monitored') ?? [];
  // Facet counts come from the current monitoring lane, before the outcome facet narrows it.
  const inView = (selectedFramework?.controls ?? []).filter((control) => {
    if (viewFilter === 'excluded') return control.monitoring.state === 'excluded';
    if (control.monitoring.state !== 'monitored') return false;
    if (viewFilter === 'needs_action') return control.outcome === 'needs_action';
    return true;
  });
  const statusCount = (outcome: ComplianceControlOutcome) => inView.filter((c) => c.outcome === outcome).length;

  return (
    <ListPageShell
      title="Control Readiness"
      subtitle="Browse framework controls, current outcomes, evidence coverage, and the agent's latest reasoning."
      metric={{
        label: 'Snapshot',
        value: (
          <span className="text-[13px] font-medium">
            {readiness?.generatedAt ? new Date(readiness.generatedAt).toLocaleString() : 'Not generated'}
          </span>
        ),
      }}
      data-tour="compliance-page"
    >
      {isLoading ? (
        <ListSkeleton label="Reading your controls" />
      ) : frameworks.length === 0 ? (
        <ListEmptyState
          icon="compliance"
          title="No compliance framework selected"
          description="Configure a framework in settings to start readiness tracking."
          action={
            <Button onClick={() => navigate(paths.scopesList)}>Choose frameworks on a scope</Button>
          }
        />
      ) : selectedFramework ? (
        <>
          {/* Framework is context, page mode is depth — both the shared status
              strip, both bone, so the page never grows a second tab language. */}
          <div className="mb-6 flex flex-col gap-1.5" data-tour="compliance-frameworks">
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.22em] text-muted-foreground/70">
              Framework
            </span>
            <StatusTabs
              aria-label="Compliance framework"
              tone="bone"
              value={selectedFramework.key}
              onChange={selectFramework}
              itemAttributes={(item) => ({ 'data-tour': `compliance-framework-${item.value}` })}
              items={frameworks.map((framework) => ({ value: framework.key, label: framework.label }))}
            />
          </div>

          <StatusTabs
            className="mb-8"
            aria-label="Compliance view"
            tone="bone"
            value={pageMode}
            onChange={(value) => setPageMode(value as PageMode)}
            itemAttributes={(item) => ({ 'data-tour': `compliance-tab-${item.value}` })}
            items={[
              { value: 'controls', label: 'Controls' },
              { value: 'evidence', label: 'Evidence Library' },
            ]}
          />

          {pageMode === 'controls' ? (
            <>
              <FrameworkDashboard framework={selectedFramework} />

              {/* The monitoring lane and the outcome are both enumerations over
                  the same list, so they are facets of the one query bar — not a
                  third strip of buttons above it. */}
              <QueryBar
                className="mb-8"
                aria-label="Filter controls"
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Search controls"
                facets={
                  <>
                    <FacetSelect
                      aria-label="Monitoring lane"
                      label="Monitored"
                      value={viewFilter}
                      onChange={(value) => setViewFilter(value as typeof viewFilter)}
                      options={[
                        { value: 'monitored', label: 'Monitored', count: monitoredControls.length },
                        {
                          value: 'needs_action',
                          label: 'Needs action',
                          count: monitoredControls.filter((c) => c.outcome === 'needs_action').length,
                          swatchClass: 'bg-warning',
                        },
                        {
                          value: 'excluded',
                          label: 'Excluded',
                          count: selectedFramework.controls.filter((c) => c.monitoring.state === 'excluded').length,
                        },
                      ]}
                    />
                    <FacetSelect
                      aria-label="Control status filter"
                      label="All statuses"
                      value={statusFilter}
                      onChange={(value) => setStatusFilter(value as typeof statusFilter)}
                      options={[
                        { value: 'all', label: 'All statuses', count: inView.length },
                        { value: 'passed', label: 'Passed', count: statusCount('passed'), swatchClass: 'bg-success' },
                        { value: 'failed', label: 'Failed', count: statusCount('failed'), swatchClass: 'bg-destructive' },
                        { value: 'needs_action', label: 'Needs action', count: statusCount('needs_action'), swatchClass: 'bg-warning' },
                        { value: 'not_checked', label: 'Not checked', count: statusCount('not_checked'), swatchClass: 'bg-muted-foreground' },
                      ]}
                    />
                  </>
                }
              />

              <ControlList
                controls={filteredControls}
                frameworkKey={selectedFramework.key}
                onOpenControl={(frameworkKey, controlId) => navigate(paths.complianceControl(frameworkKey, controlId))}
                onUpdateControls={requestControlStateChange}
                updateDisabled={bulkUpdateControlState.isPending}
              />
            </>
          ) : (
            <EvidenceLibrary
              scopeId={activeScopeId}
              frameworkKey={selectedFramework?.key ?? null}
              onUpload={() => {
                setUploadOpen(true);
              }}
              availableControls={
                selectedFramework
                  ? selectedFramework.controls.map((control) => ({
                    id: control.id,
                    title: control.title,
                    frameworkKey: selectedFramework.key,
                  }))
                  : []
              }
            />
          )}
        </>
      ) : null}
      <EvidenceUploadModal
        isOpen={uploadOpen}
        onClose={() => setUploadOpen(false)}
        scopeId={activeScopeId}
        targetItem={null}
      />
      {/* The shared modal frame — this dialog used to hand-roll its own scrim,
          shadow and buttons, which is how a third dialog language appears. */}
      <Modal
        isOpen={bulkAction !== null}
        onClose={() => setBulkAction(null)}
        title="Exclude controls"
        size="md"
      >
        <ModalContent>
          <p className="text-sm leading-6 text-muted-foreground">
            {bulkAction?.controlIds.length} control{bulkAction?.controlIds.length === 1 ? '' : 's'} in{' '}
            {bulkAction?.label} will stay visible but leave the active readiness denominator.
          </p>
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-foreground">Exclusion reason</span>
            <Textarea
              value={bulkReason}
              onChange={(event) => setBulkReason(event.target.value)}
              rows={4}
              placeholder="Why these controls are not monitored for this scope"
            />
          </label>
        </ModalContent>
        <ModalFooter>
          <Button variant="outline" onClick={() => setBulkAction(null)}>
            Cancel
          </Button>
          <Button onClick={submitBulkAction} loading={bulkUpdateControlState.isPending}>
            Exclude
          </Button>
        </ModalFooter>
      </Modal>
    </ListPageShell>
  );
}
