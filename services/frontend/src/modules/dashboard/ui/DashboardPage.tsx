import {
  useComplianceReadinessQuery,
  useDashboardOverviewV2,
  useRisksQuery,
  useRiskSummaryQuery,
  useScopeTargetsQuery,
} from '@/modules/security-ops/api';
import type {
  ComplianceReadinessResponse,
  ScopeTarget,
} from '@/modules/security-ops/types';
import { COMPLIANCE_FRAMEWORK_SHORT_LABELS, type ComplianceFrameworkKey } from '@/modules/security-ops/complianceFrameworks';
import { useProfile } from '@modules/auth/api/useProfile';
import TargetVerificationModal from '@modules/scopes/ui/components/TargetVerificationModal';
import { DashboardFirstRun, DashboardVerificationGate } from './DashboardFirstRun';
import {
  cn,
  CellIcon,
  ListMetrics,
  ListPageShell,
  SegmentedControl,
  ActivityHeatmap,
  ChartBand,
  ChartFrame,
  RadarChart,
  RankedBars,
  Sparkline,
  StackedBars,
  DonutChart,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger, severityTone } from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import {
  ChevronRight,
  Layers,
  Shield,
  ShieldCheck,
} from 'lucide-react';
import React from 'react';
import { useNavigate } from 'react-router-dom';

/** The greeting used to say "afternoon" at every hour of the day. */
const greetingForHour = (hour: number): string => {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
};

// --- Specific Dashboard Widgets ---

// --- Activity Heatmap (GitHub style) --
// --- Trend Chart ---
// Minimal Box Container
/**
 * The subject of the page, on the heading's own line.
 *
 * It was a block of its own with a band of empty space above and below it,
 * which made "which website is this?" the third question the page answered
 * instead of part of the title. The host is real data, so it sets in mono;
 * everything around it is chrome and does not.
 */
function PrimaryTargetStatus({ target }: { target: ScopeTarget }) {
  // Only ever the verified case: an unverified domain never reaches this page,
  // because `DashboardVerificationGate` replaces it.
  return (
    <span
      aria-label={`Primary target ${target.value}, verified`}
      className="flex min-w-0 max-w-full items-center gap-3"
    >
      <CellIcon name="website-watch" size={18} className="text-muted-foreground" />
      <span className="truncate font-mono text-sm font-bold text-foreground">{target.value}</span>
      <ShieldCheck aria-label="Verified" className="h-3.5 w-3.5 flex-none text-success" />
    </span>
  );
}

function getSecurityGradeTone(grade: string | null | undefined) {
  if (!grade) return 'text-foreground/30';
  if (grade.startsWith('A')) return 'text-success';
  if (grade.startsWith('B')) return 'text-primary';
  if (grade.startsWith('C')) return 'text-primary/70';
  return 'text-destructive';
}

/**
 * The grade — still the biggest thing on the page, because it is the page's
 * one answer.
 *
 * What it drops is the apparatus around it: a two-line mono caption in italic
 * reading "computed via academic +/- rubric across 2 data vectors", a rule, a
 * letterspaced kicker at 0.4em, and a hover that scaled the letter. The
 * measurement stayed the same size; everything explaining it went behind the
 * figure, where an explanation belongs. The `compliance` mark names what is
 * being scored, at the size the icon doc asks for.
 */
function SecurityGradeProminent({
  grade,
  confidence,
  rationale,
}: {
  grade: string;
  confidence: string;
  rationale: string[];
}) {
  const isPending = grade === '--' || !grade;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex cursor-help flex-col items-end">
            <span
              className={cn(
                'text-[4.5rem] font-extrabold leading-[0.85] tracking-[-0.055em] tabular-nums',
                getSecurityGradeTone(isPending ? null : grade),
              )}
            >
              {isPending ? '--' : grade}
            </span>
            <span className="mt-3 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
              Security posture
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="left" className="z-50 max-w-sm border-border-strong bg-background p-5">
          <div className="mb-3 flex items-center justify-between gap-6 border-b border-border pb-3">
            <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-foreground">
              <Shield className="h-3.5 w-3.5" /> How this was scored
            </span>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              {isPending ? 'Pending' : `${confidence} confidence`}
            </span>
          </div>
          {isPending ? (
            <p className="text-sm text-muted-foreground">
              No assessment has run yet, so there is nothing to grade.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {rationale.map((reason) => (
                <li key={reason} className="flex gap-3 text-[13px] leading-relaxed text-foreground/80">
                  <span aria-hidden className="mt-[7px] h-1 w-1 flex-none bg-primary" />
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComplianceReadinessPanel({
  readiness,
  onOpenDetails,
}: {
  readiness?: ComplianceReadinessResponse | null;
  onOpenDetails: () => void;
}) {
  const frameworks = readiness?.frameworks ?? [];
  // Only frameworks we actually score can be an axis; an unsupported one would
  // read as a zero rather than as "we do not measure this".
  const supportedFrameworks = frameworks.filter((fw) => fw.supported);

  if (!readiness) {
    return (
      <div className="py-2 text-sm text-muted-foreground">
        Loading readiness
      </div>
    );
  }

  if (frameworks.length === 0) {
    return (
      <div className="py-2">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          Compliance Readiness
        </div>
        <p className="text-sm text-foreground/80">
          No compliance framework is selected in organization context or scope rules of engagement.
        </p>
        <button
          type="button"
          onClick={onOpenDetails}
          className="mt-4 inline-flex h-9 items-center gap-2 border border-border px-3 text-sm text-muted-foreground transition-colors hover:border-foreground/50 hover:text-foreground"
        >
          Details
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Still needed for the counts under the web and for the single-framework
  // case, where a radar has nothing to compare.
  const active = frameworks.find((fw) => fw.selected) ?? frameworks[0];

  const outcomeTiles = [
    { key: 'passed' as const, label: 'Passed', barColor: 'var(--ns-success)' },
    { key: 'failed' as const, label: 'Failed', barColor: 'var(--ns-critical)' },
    { key: 'needs_action' as const, label: 'Needs action', barColor: 'var(--ns-medium)' },
    { key: 'not_checked' as const, label: 'Not checked', barColor: 'var(--ns-fg-muted)' },
  ];

  return (
    <div className="space-y-4">
      <div>
        {supportedFrameworks.length >= 3 ? (
          <RadarChart
            emptyIcon="compliance"
            emptyLabel="Not enough frameworks to compare"
            axes={supportedFrameworks.map((fw) => ({
              label: COMPLIANCE_FRAMEWORK_SHORT_LABELS[fw.key as ComplianceFrameworkKey] ?? fw.label,
              value: fw.score,
            }))}
          />
        ) : null}

        {active.supported ? (
          <>
            {supportedFrameworks.length < 3 ? (
              <div className="mt-1">
                <DonutChart
                  centerValue={`${active.score}%`}
                  centerLabel="Ready"
                  segments={outcomeTiles.map((tile) => ({
                    label: tile.label,
                    value: active.outcomeCounts[tile.key] ?? 0,
                    color: tile.barColor,
                  }))}
                />
              </div>
            ) : null}

          </>
        ) : (
          <p className="mt-4 text-sm text-foreground/80">
            {active.label} is selected but does not yet have an agent-checkable control set. Tracked as planned.
          </p>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { activeScopeId } = useScope();
  const paths = useAppPaths();
  const [windowDays, setWindowDays] = React.useState(30);
  const [verificationTarget, setVerificationTarget] = React.useState<ScopeTarget | null>(null);
  const { data: scopeTargets = [] } = useScopeTargetsQuery(activeScopeId ?? '', {
    enabled: Boolean(activeScopeId),
  });

  const { data: v2Data, isLoading: isLoadingV2 } = useDashboardOverviewV2(activeScopeId, windowDays);
  const { data: complianceReadiness } = useComplianceReadinessQuery(activeScopeId);
  const { data: risks } = useRisksQuery(activeScopeId);
  const { data: riskSummary } = useRiskSummaryQuery(activeScopeId);
  const { profile } = useProfile();
  const greeting = greetingForHour(new Date().getHours());
  const primaryTarget = scopeTargets.find((target) => target.type === 'domain') ?? scopeTargets[0] ?? null;

  const isLoading = isLoadingV2;

  // -- Derived Values --
  const securityPosture = v2Data?.securityPosture ?? null;

  const criticalCount = riskSummary?.openBySeverity.critical ?? 0;
  const highCount = riskSummary?.openBySeverity.high ?? 0;
  const mediumCount = riskSummary?.openBySeverity.medium ?? 0;
  const lowCount = riskSummary?.openBySeverity.low ?? 0;
  const infoCount = riskSummary?.openBySeverity.info ?? 0;

  const openCount = riskSummary?.open ?? 0;
  const potentialCount = riskSummary?.byState.potential ?? 0;
  const verifyingCount = riskSummary?.byState.verifying ?? 0;
  const openKevCount = riskSummary?.openKev ?? 0;
  const potentialOrVerifyingCount = potentialCount + verifyingCount;
  const topRisks = [...(risks ?? [])]
    .filter((risk) => risk.state !== 'resolved' && risk.state !== 'dismissed' && risk.state !== 'accepted')
    .sort((left, right) => (right.cvssScore ?? 0) - (left.cvssScore ?? 0))
    .slice(0, 5);
  const runsCount = v2Data?.posture.runsInWindow ?? 0;
  const activeRunsCount = v2Data?.activeRuns ?? 0;
  const securityGrade = (runsCount === 0) ? '--' : (securityPosture?.grade ?? '--');
  const securityConfidence = (runsCount === 0) ? 'N/A' : (securityPosture?.confidence ?? 'low');
  const securityRationale = (runsCount === 0) 
    ? ['Awaiting first operational run to establish baseline.'] 
    : (securityPosture?.rationale ?? ['Awaiting evidence from the current testing cycle.']);
  
  const trendData = v2Data?.lifecycle.trend ?? [];
  const heatmapData = v2Data?.cadence.heatmap ?? [];
  const topAffectedAssets = v2Data?.assets.topAffected ?? [];
  const owaspData = v2Data?.categories.owasp ?? [];
  const recentRuns = v2Data?.recentRuns ?? [];

  /**
   * Nothing has ever landed on this scope. Not "the window is empty" — the
   * window control would fix that — but no run, no risk, no asset, ever. Eight
   * empty widgets is the wrong answer to that; there is one thing to do and
   * the page should be it.
   */

  const isFirstRun =
    runsCount === 0 &&
    activeRunsCount === 0 &&
    openCount === 0 &&
    topRisks.length === 0 &&
    topAffectedAssets.length === 0 &&
    trendData.length === 0;

  const severityData = [
    { label: 'Critical', count: criticalCount, color: 'var(--ns-critical)' },
    { label: 'High', count: highCount, color: 'var(--ns-high)' },
    { label: 'Medium', count: mediumCount, color: 'var(--ns-medium)' },
    { label: 'Low', count: lowCount, color: 'var(--ns-low)' },
    { label: 'Info', count: infoCount, color: 'var(--ns-info)' },
  ].filter(d => d.count > 0);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground font-mono pb-20 p-6 md:p-8 text-muted-foreground flex justify-center items-center h-full">
         /// PREPARING INTERFACE...
      </div>
    );
  }

  // A gate, before anything else is drawn. Until we are allowed to test the
  // domain there are no figures to report and no grade to give, so a greeting
  // over a board of empty widgets would be eight pieces of furniture in front
  // of the one door.
  if (!primaryTarget || !primaryTarget.verified) {
    return (
      <div className="min-h-screen bg-background font-sans text-foreground">
        <DashboardVerificationGate
          target={primaryTarget}
          onVerify={() => primaryTarget && setVerificationTarget(primaryTarget)}
          onAddTarget={() => navigate(paths.scopesList)}
        />
        {verificationTarget && activeScopeId ? (
          <TargetVerificationModal
            open
            target={verificationTarget}
            scopeId={activeScopeId}
            onClose={() => setVerificationTarget(null)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <ListPageShell
        data-tour="dashboard-page"
        title={
          // The greeting stays — it is the one place the product speaks to a
          // person rather than about a system. What changed is that it is now
          // the page's real h1 at every width: it used to be `hidden xl:block`,
          // so on a laptop the page opened with no heading at all.
          <span className="flex items-center gap-5">
            <CellIcon name="dashboard" size={34} className="text-foreground/70" />
            <span>
              {greeting}, {profile?.full_name || 'Operator'}.
            </span>
          </span>
        }
        subtitle={
          primaryTarget ? (
            <PrimaryTargetStatus target={primaryTarget} />
          ) : (
            'Everything this scope currently knows.'
          )
        }
        actions={
          <SecurityGradeProminent
            grade={securityGrade}
            confidence={securityConfidence}
            rationale={securityRationale}
          />
        }
    >
            {/* One page, one state. When the board would be empty anyway, the
                thing standing between this scope and a dashboard *is* the
                page — a subscription prompt in a one-line strip put the only
                available decision in the smallest element on screen, above
                eight widgets that could not work without it. Once anything
                has landed, the board wins and the prompt goes back to being a
                strip. */}
            {isFirstRun ? (
              <DashboardFirstRun target={primaryTarget} />
            ) : (
              <>
            {/* Seven figures, down to four or six. The strip answers one
                question — how much is open, how urgent, and when we last
                looked — and everything that was not part of that answer had a
                better home: critical and high are one figure because they are
                one decision (nobody acts on them differently), recovery time
                is a trend and lives on the trajectory, and a running agent is
                live state rather than a measurement. */}
            <ListMetrics
              label="Open exposure"
              className="mb-14"
              items={[
                { label: 'Open risks', value: openCount },
                {
                  label: 'Critical & high',
                  value: criticalCount + highCount,
                  severity: 'critical',
                },
                ...(potentialOrVerifyingCount > 0
                  ? [{ label: 'Potential', value: potentialOrVerifyingCount } as const]
                  : []),
                ...(openKevCount > 0
                  ? [{ label: 'KEV listed', value: openKevCount, severity: 'critical' } as const]
                  : []),
              ]}
            />

            {/* Layout Body */}
            <div className="flex flex-col gap-16">
              <ChartBand first>
                {/* The window sits here, not in the page header, because it is
                    not a page-level filter: the figures above are current
                    state and do not move with it. Everything it does change is
                    in this region, and this is the first and largest of them. */}
                <ChartFrame
                  span={12}
                  icon="activity"
                  title="Vulnerability trajectory"
                  caption="Open and resolved backlog by day"
                  height={280}
                  action={
                    <SegmentedControl
                      label="Reporting window"
                      value={windowDays}
                      onChange={setWindowDays}
                      options={[
                        { value: 7, label: '7d' },
                        { value: 30, label: '30d' },
                        { value: 90, label: '90d' },
                        { value: 365, label: 'All' },
                      ]}
                    />
                  }
                >
                  <Sparkline
                    emptyIcon="activity"
                    emptyLabel="No history yet — the first assessment starts this line"
                    height={260}
                    showAxis
                    showLegend
                    labels={trendData.map((point) => point.date)}
                    series={[
                      {
                        key: 'open',
                        label: 'Open risk',
                        lead: true,
                        color: 'var(--ns-critical)',
                        values: trendData.map((point) => point.active),
                      },
                      {
                        key: 'created',
                        label: 'Potential',
                        stroke: 'dotted',
                        color: 'var(--ns-medium)',
                        values: trendData.map((point) => point.created),
                      },
                      {
                        key: 'resolved',
                        label: 'Resolved',
                        stroke: 'solid',
                        color: 'var(--ns-success)',
                        values: trendData.map((point) => point.resolved),
                      },
                    ]}
                  />
                </ChartFrame>

              </ChartBand>

              <ChartBand>
                <ChartFrame span={7} icon="findings"
                  title="Top risks" caption="Ranked by highest CVSS impact" action={<button onClick={() => navigate(paths.risksList)} className="text-sm text-muted-foreground transition-colors hover:text-foreground">View all</button>}>
                                <div className="flex-1 divide-y divide-border">
                                    {topRisks.map((risk) => (
                                        <button
                                          key={risk.key}
                                          type="button"
                                          className="group flex w-full items-center gap-4 py-3.5 text-left transition-colors hover:bg-foreground/[0.03]"
                                          onClick={() => navigate(risk.recordKind === 'exposure' ? paths.exposureDetail(risk.id) : paths.findingDetail(risk.id))}
                                        >
                                            <span
                                              aria-hidden
                                              className={cn('h-9 w-[3px] flex-none', severityTone(risk.severity, 'bg'))}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-semibold text-foreground">
                                                    {risk.title}
                                                </span>
                                                <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                                                    {risk.assetValue}
                                                </span>
                                            </span>
                                            <span
                                              className={cn(
                                                'flex-none font-mono text-base font-bold tabular-nums',
                                                severityTone(risk.severity),
                                              )}
                                              title={`${risk.severity} · CVSS ${risk.cvssScore ?? 'n/a'}`}
                                            >
                                                {risk.cvssScore != null ? risk.cvssScore.toFixed(1) : '—'}
                                            </span>
                                        </button>
                                    ))}
                                    {topRisks.length === 0 && (
                                        <p className="py-10 text-center text-sm text-muted-foreground">No risks detected</p>
                                    )}
                                </div>
                         </ChartFrame>

                         <ChartFrame
                             span={5}
                             icon="assets"
                  title="Tested risk severity"
                             caption="Open tested risks mapped across assets"
                             action={<button onClick={() => navigate(paths.assetsList)} className="text-sm text-muted-foreground transition-colors hover:text-foreground">View all</button>}
                           >
                             {/* Three dots beside a name said an asset had
                                 criticals; it never said how many, or which
                                 asset carries the most. The column height is
                                 the total and the colour is the mix, so both
                                 questions are answered by one picture. */}
                             <StackedBars
                               height={220}
                               segments={[
                                 { key: 'critical', label: 'Critical', color: 'var(--ns-critical)' },
                                 { key: 'high', label: 'High', color: 'var(--ns-high)' },
                                 { key: 'other', label: 'Other', color: 'var(--ns-medium)' },
                               ]}
                               columns={topAffectedAssets.slice(0, 5).map((asset) => ({
                                 label: asset.assetValue,
                                 values: {
                                   critical: asset.criticalCount,
                                   high: asset.highCount,
                                   other: Math.max(
                                     0,
                                     asset.openCount - asset.criticalCount - asset.highCount,
                                   ),
                                 },
                                 onSelect: asset.assetId
                                   ? () => navigate(paths.assetDetail(asset.assetId as string))
                                   : undefined,
                               }))}
                               emptyIcon="assets"
                               emptyLabel="No assets carry open tested risk yet"
                             />
                           </ChartFrame>

              </ChartBand>

              {/* Four, three and five: the radar needs room for its labels, the
                  ring needs none now that it has no legend, and the OWASP names
                  are the longest strings on the page. */}
              <ChartBand>
                <ChartFrame
                    span={4}
                    height={280}
                    icon="compliance"
                  title="Compliance readiness"
                    caption="Evidence coverage, every framework at once"
                  >
                    <ComplianceReadinessPanel
                      readiness={complianceReadiness}
                      onOpenDetails={() => navigate(paths.compliance)}
                    />
                  </ChartFrame>

                <ChartFrame
                  span={3}
                  height={280}
                  icon="exposures"
                  title="Severity breakdown"
                  caption="Point at a band for its tier"
                >
                  {/* No legend: it repeated every label permanently to answer a
                      question asked one tier at a time, and it took half the
                      cell. The arc under the cursor names itself instead. */}
                  <DonutChart
                    className="h-full justify-center"
                    size={188}
                    showLegend={false}
                    emptyIcon="findings"
                    emptyLabel="No open risks to break down"
                    centerValue={openCount}
                    centerLabel="Open"
                    segments={severityData.map((row) => ({
                      label: row.label,
                      value: row.count,
                      color: row.color,
                    }))}
                    onSegmentSelect={() => navigate(paths.risksList)}
                  />
                </ChartFrame>

                <ChartFrame
                  span={5}
                  icon="reports"
                  title="Issues by classification"
                  caption="OWASP Top 10 category mapping"
                >
                  <RankedBars
                    emptyIcon="reports"
                    emptyLabel="Nothing classified yet"
                    items={owaspData.map((row) => ({
                      code: row.category.split(':')[0]?.split(' ')[0],
                      label: row.category.replace(/^A\d+[: ]\s*/, ''),
                      value: row.count,
                      onSelect: () => navigate(paths.risksList),
                    }))}
                  />
                </ChartFrame>
              </ChartBand>

              <ChartBand>
                <ChartFrame span={5} icon="schedule"
                  title="Testing tempo" caption="Assessment cadence over 42 cycles">
                  <ActivityHeatmap
                    data={heatmapData}
                    emptyIcon="schedule"
                    emptyLabel="No assessments recorded yet"
                  />
                </ChartFrame>

                    <ChartFrame
                      span={7}
                      icon="runs"
                      title="Recent operations"
                      caption="Target logs and diagnostic hits"
                      action={<button onClick={() => navigate(paths.runsList)} className="text-sm text-muted-foreground transition-colors hover:text-foreground">View all</button>}
                    >
                         <div className="divide-y divide-border/10 -mx-5 -mb-5 flex-1">
                            {recentRuns.map(run => (
                                <div
                                    key={run.id}
                                    onClick={() => navigate(paths.runDetail(run.id))}
                                    className="px-5 py-3 hover:bg-surface-inset transition-colors cursor-pointer flex justify-between items-center gap-4"
                                >   
                                     <div className="flex-1 min-w-0">
                                         <div className="text-[12px] font-medium text-foreground truncate hover:text-primary transition-colors">
                                           {run.title || run.goal || `Run ${run.displayId || run.id.split('-')[0]}`}
                                         </div>
                                         <div className="text-[8px] text-muted-foreground font-mono mt-0.5 uppercase flex gap-2">
                                             <Layers className="w-2 h-2" /> {run.status}
                                         </div>
                                     </div>
                                     <div className="flex items-center gap-2 flex-shrink-0">
                                         {run.status === 'completed' && <div className="h-1.5 w-1.5 bg-success" />}
                                         {run.status === 'failed' && <div className="h-1.5 w-1.5 bg-destructive" />}
                                         {(run.status === 'running' || run.status === 'queued') && <span className="ns-live-mark" aria-hidden />}
                                     </div>
                                </div>
                            ))}
                        </div>
                    </ChartFrame>
              </ChartBand>
            </div>
              </>
            )}

            {verificationTarget && activeScopeId ? (
              <TargetVerificationModal
                open
                target={verificationTarget}
                scopeId={activeScopeId}
                onClose={() => setVerificationTarget(null)}
              />
            ) : null}
    </ListPageShell>
  );
}


