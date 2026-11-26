import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Clock, ExternalLink } from 'lucide-react';
import {
  Button,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailRailNote,
  DetailSection,
  SeverityBadge,
  StatusTabs,
  ExposureStateBadge,
  KevBadge,
  MatchCaveatBadge,
} from '@null-ai/design-tokens/ui';
import {
  useExposureDetailQuery,
  useVerifyExposureMutation,
  useDismissExposureMutation,
  useCreateExposureOverrideMutation,
  useDeleteExposureOverrideMutation,
} from '@/modules/security-ops/api';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useHasCapability } from '@/modules/permissions';
import { TimeAgo } from '@shared/ui/TimeAgo';
import {
  ExposureCorrectionDialog,
  type ExposureCorrectionInput,
} from './components/ExposureCorrectionDialog';
import {
  ExposureVerificationDialog,
  type ExposureVerificationTarget,
} from './components/ExposureVerificationDialog';

const OPEN_STATES = ['candidate', 'notified', 'verifying', 'inconclusive'];
const CORRECTABLE_STATES = ['candidate', 'notified', 'inconclusive', 'stale'];

const CONFIDENCE_COPY: Record<string, string> = {
  exact_version:
    'The evaluated version falls inside a range the advisory describes as affected.',
};

const EVIDENCE_COPY: Record<string, string> = {
  observed_exact: 'Authoritative version from a connected-site or dependency manifest',
  attested_exact: 'Time-bounded version correction supplied by your team',
  reported_exact: 'Version reported by scanner or banner evidence; not interrupt-eligible by itself',
  absent: 'No usable version evidence',
};

/**
 * One exposure, in enough detail to decide whether to test it.
 *
 * The list is a queue; this is the page where somebody works out whether the
 * match is worth testing. That means it has to be candid about *why* we think
 * this applies and what could make us wrong — the confidence basis and the
 * caveats are the point of the page, not decoration.
 */
export default function ExposureDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [verificationTarget, setVerificationTarget] = useState<ExposureVerificationTarget | null>(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const paths = useAppPaths();
  const canVerify = useHasCapability('org.run.start');
  const { data, isLoading, isError } = useExposureDetailQuery(id ?? '');
  const verify = useVerifyExposureMutation();
  const dismiss = useDismissExposureMutation();
  const saveOverride = useCreateExposureOverrideMutation();
  const removeOverride = useDeleteExposureOverrideMutation();

  if (isLoading) {
    return (
      <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-background text-sm text-muted-foreground">
        <span className="ns-live-mark mr-3" aria-hidden />
        Loading risk
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex min-h-[calc(100vh-64px)] items-center justify-center bg-background p-6 font-sans text-foreground">
        <div className="max-w-xl border-l-2 border-destructive py-4 pl-6">
          <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
          <h2 className="mt-5 text-xl font-semibold">This advisory risk could not be loaded</h2>
          <Link to={paths.risksList} className="mt-4 inline-block text-sm text-primary hover:underline">
            Back to Risks
          </Link>
        </div>
      </div>
    );
  }

  const { match, advisory, component, assetValue } = data;
  const events = data.events ?? [];
  const observations = data.observations ?? [];
  const affectedRanges = data.affectedRanges ?? [];
  const activeOverride = data.override ?? null;
  const canStartVerification = OPEN_STATES.includes(match.state) && match.state !== 'verifying';
  const canCorrect = CORRECTABLE_STATES.includes(match.state);
  const confidenceCopy = match.matchConfidence ? CONFIDENCE_COPY[match.matchConfidence] : null;
  const effectiveVersion = match.versionEvaluated
    ?? (activeOverride?.action === 'version_correction'
      ? activeOverride.correctedVersion
      : component.resolvedVersion);
  const correctionIsPending = dismiss.isPending || saveOverride.isPending;
  const correctionError = dismiss.isError
    ? 'This advisory could not be closed. Nothing was changed.'
    : saveOverride.isError
      ? 'This inventory correction could not be saved. Nothing was changed.'
      : null;

  const submitCorrection = (input: ExposureCorrectionInput) => {
    if (input.kind === 'advisory_not_applicable') {
      dismiss.mutate(
        { matchId: match.id, reason: input.reason },
        { onSuccess: () => setCorrectionOpen(false) },
      );
      return;
    }

    saveOverride.mutate(
      {
        matchId: match.id,
        action: input.kind,
        reason: input.reason,
        correctedVersion: input.correctedVersion,
      },
      { onSuccess: () => setCorrectionOpen(false) },
    );
  };

  // Same rail as every other detail page: the scores that rank this risk, the
  // state of anything in flight, and the page's one yellow on its verb.
  const rail = (
    <DetailRailBlock label="Scores">
      <div className="space-y-3 text-sm">
        <Row label="CVSS">{advisory.cvssV31Score != null ? advisory.cvssV31Score.toFixed(1) : '—'}</Row>
        <Row label="EPSS">
          {advisory.epssPercentile != null ? `${Math.round(advisory.epssPercentile * 100)}th percentile` : '—'}
        </Row>
        <Row label="CISA KEV">{advisory.kevListed ? 'Listed — exploited in the wild' : 'Not listed'}</Row>
      </div>

      {match.findingId ? (
        <DetailRailNote title="Reproduced">
          This was reproduced and became a confirmed risk with its evidence attached.{' '}
          <Link to={paths.findingDetail(match.findingId)} className="font-medium text-foreground hover:underline">
            View the tested risk
          </Link>
          .
        </DetailRailNote>
      ) : null}

      {match.stateReason ? (
        <DetailRailNote title="Latest outcome">{match.stateReason}</DetailRailNote>
      ) : null}

      {canVerify && canStartVerification ? (
        <div>
          <Button
            className="w-full justify-center rounded-none text-[10px] uppercase tracking-widest"
            disabled={verify.isPending}
            onClick={() =>
              setVerificationTarget({ id: match.id, advisoryId: advisory.canonicalId, assetValue })
            }
          >
            {verify.isPending ? 'Starting…' : 'Verify advisory risk'}
          </Button>
          <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
            Starts a focused assessment against this one advisory on this one asset. It uses your model key.
          </p>
        </div>
      ) : null}

      {canVerify && canCorrect ? (
        <Button
          variant="outline"
          className="w-full justify-center rounded-none border-border text-[10px] uppercase tracking-widest hover:border-foreground/40 hover:text-foreground"
          disabled={correctionIsPending}
          onClick={() => setCorrectionOpen(true)}
        >
          Correct match
        </Button>
      ) : null}

      {verify.isError || removeOverride.isError ? (
        <DetailRailNote role="alert" tone="destructive" title="That did not go through">
          {verify.isError
            ? 'Verification could not be started. No second run was started; try again.'
            : 'The saved correction could not be removed. It remains active.'}
        </DetailRailNote>
      ) : null}

      {saveOverride.data?.reconciliationPending || removeOverride.data?.reconciliationPending ? (
        <DetailRailNote role="status" tone="warning" title="Re-evaluating">
          Your correction was saved, but this match is still being re-evaluated. Threat Watch will
          apply it again on the next monitoring cycle.
        </DetailRailNote>
      ) : null}
    </DetailRailBlock>
  );

  return (
    <DetailPageShell
      backLink={<DetailBackLink label="Back to Risks" onClick={() => navigate(paths.risksList)} />}
      displayId={`Priority ${match.priorityScore ?? '—'}`}
      rail={rail}
    >
      <DetailHeader
        badges={
          <>
            <ExposureStateBadge state={match.state} />
            <SeverityBadge severity={advisory.severity ?? 'medium'} />
            {advisory.kevListed ? <KevBadge /> : null}
            {component.backportRisk ? <MatchCaveatBadge kind="backport" /> : null}
            {component.versionConflict ? <MatchCaveatBadge kind="conflict" /> : null}
          </>
        }
        title={`${advisory.canonicalId} in ${component.displayName}${effectiveVersion ? ` ${effectiveVersion}` : ''}`}
        subline={[
          <Link
            key="asset"
            to={paths.assetDetail(match.assetId)}
            className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground/50"
          >
            {assetValue}
          </Link>,
          <span key="seen">
            First seen <TimeAgo date={match.firstSeenAt} />
          </span>,
        ]}
      />

      {/* The same four-tab skeleton as the other risk detail page, so moving
          between an advisory match and a tested finding does not feel like
          moving between two products. */}
      <StatusTabs
        className="mt-10"
        tone="bone"
        aria-label="Risk sections"
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'evidence', label: 'Evidence' },
          { value: 'advisory', label: 'Advisory' },
          { value: 'history', label: 'History' },
        ]}
      />

      <div className="mt-8 min-h-[400px] space-y-8">
        {activeTab === 'overview' ? (
          <>
            {/*
              The unverified state is stated in prose, not just implied by a
              badge. This is the moment somebody decides to spend money, and the
              product's credibility depends on them not mistaking a version
              match for a demonstrated compromise.
            */}
            {OPEN_STATES.includes(match.state) || match.state === 'stale' ? (
              <div className="border-l-2 border-warning py-1 pl-5">
                <p className="text-sm text-foreground">
                  <span className="font-semibold">
                    {match.state === 'stale'
                      ? 'The software observation behind this match is stale.'
                      : 'This has not been tested yet.'}
                  </span>{' '}
                  We matched an observed software version against an advisory. A focused
                  verification determines whether the documented issue is exploitable here.
                </p>
              </div>
            ) : null}

            {match.state === 'not_reproduced' ? (
              <div className="border-l-2 border-border py-1 pl-5">
                <p className="text-sm text-foreground">
                  <span className="font-semibold">The documented vector did not work here.</span>{' '}
                  That is not proof the host is unaffected — a different vector, or a
                  configuration we could not reach, may still apply.
                </p>
              </div>
            ) : null}

            {activeOverride ? (
              <div className="border-l-2 border-primary py-1 pl-5">
                <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-primary">
                  Your inventory correction is active
                </div>
                <p className="mt-2 text-sm text-foreground">
                  {activeOverride.action === 'version_correction'
                    ? `Threat Watch now evaluates ${component.displayName} as version ${activeOverride.correctedVersion}.`
                    : `Threat Watch no longer treats ${component.displayName} as installed on this asset.`}
                </p>
                {activeOverride.reason ? (
                  <p className="mt-2 text-xs text-muted-foreground">Reason: {activeOverride.reason}</p>
                ) : null}
                {canVerify ? (
                  <button
                    type="button"
                    onClick={() => removeOverride.mutate(match.id)}
                    disabled={removeOverride.isPending}
                    className="mt-3 text-sm font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {removeOverride.isPending ? 'Removing correction…' : 'Remove correction'}
                  </button>
                ) : null}
              </div>
            ) : null}
            <DetailSection label="Why we think this applies">
              <dl className="space-y-4 text-sm">
                <Row label="Component observed">
                  {component.displayName}
                  {component.resolvedVersion ? ` ${component.resolvedVersion}` : ' (version unknown)'}
                </Row>
                {activeOverride?.action === 'version_correction' ? (
                  <Row label="Version used for matching">
                    {activeOverride.correctedVersion}
                    <span className="ml-2 text-xs text-muted-foreground">(corrected by your team)</span>
                  </Row>
                ) : null}
                <Row label="Identified as">
                  <span className="font-mono text-xs">{component.componentKey}</span>
                </Row>
                <Row label="Match basis">
                  {confidenceCopy ?? match.matchConfidence ?? 'Unknown'}
                </Row>
                <Row label="Evidence basis">
                  {match.evidenceTier
                    ? EVIDENCE_COPY[match.evidenceTier] ?? match.evidenceTier
                    : 'Legacy evidence provenance unavailable'}
                  {match.evidenceSource ? ` (${match.evidenceSource.replace(/_/g, ' ')})` : ''}
                </Row>
                <Row label="Last observed">
                  <TimeAgo date={match.inventoryObservedAt} />
                </Row>
              </dl>

              {component.backportRisk || component.versionConflict ? (
                <div className="mt-5 border-l-2 border-border py-3 pl-4 text-sm text-muted-foreground">
                  {component.backportRisk ? (
                    <p>
                      The distribution may have patched this without changing the version string,
                      so the banner alone cannot settle it.
                    </p>
                  ) : null}
                  {component.versionConflict ? (
                    <p className={component.backportRisk ? 'mt-2' : undefined}>
                      Two sources reported different versions for this component, so the version
                      we matched on may not be the one running.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </DetailSection>
          </>
        ) : null}

        {activeTab === 'evidence' ? <DetailSection label="What we observed">
              {observations.length === 0 ? (
                <div className="border-l-2 border-border py-3 pl-4 text-sm text-muted-foreground">
                  The underlying observation is not available for this historical match. Treat the
                  product and version claim with lower confidence until the asset is observed again.
                </div>
              ) : (
                <div className="space-y-3">
                  {observations.map((observation) => (
                    <article key={observation.id} className="border border-border/60 bg-background/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-medium text-foreground">
                          {observation.versionNormalized ?? observation.versionRaw ?? 'Version not readable'}
                          {observation.port != null ? ` on port ${observation.port}` : ''}
                        </div>
                        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          {observationSourceLabel(observation.source)} · <TimeAgo date={observation.observedAt} />
                        </div>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Observation confidence:{' '}
                        {observation.confidence == null
                          ? 'not scored'
                          : `${confidenceLabel(observation.confidence)} (${Math.round(observation.confidence * 100)}%)`}
                      </div>
                      {observation.evidence.map((evidence, index) => (
                        <div key={`${observation.id}-evidence-${index}`} className="mt-3 bg-muted/30 p-3">
                          {evidence.label ? (
                            <div className="text-xs font-medium text-foreground">{evidence.label}</div>
                          ) : null}
                          {evidence.excerpt ? (
                            <div className="mt-1 break-words font-mono text-xs text-muted-foreground">
                              {evidence.excerpt}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </article>
                  ))}
                </div>
              )}
            </DetailSection> : null}

        {activeTab === 'advisory' ? <DetailSection label="Advisory">
              {advisory.summary ? (
                <p className="max-w-[72ch] text-[15px] leading-7 text-foreground">{advisory.summary}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No summary was published with this advisory.
                </p>
              )}
              <dl className="mt-5 space-y-4 text-sm">
                <Row label="Source">{advisory.canonicalSource.toUpperCase()}</Row>
                <Row label="Published">
                  {advisory.publishedAt ? <TimeAgo date={advisory.publishedAt} /> : 'Unknown'}
                </Row>
                {advisory.cweIds?.length ? (
                  <Row label="Weaknesses">{advisory.cweIds.join(', ')}</Row>
                ) : null}
                {advisory.cveId ? (
                  <Row label="Reference">
                    <a
                      href={`https://nvd.nist.gov/vuln/detail/${advisory.cveId}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1.5 text-primary hover:underline"
                    >
                      View on NVD <ExternalLink className="h-3 w-3" />
                    </a>
                  </Row>
                ) : null}
              </dl>
              <div className="mt-6">
                <div className="mb-3 text-sm font-medium text-foreground">Affected versions</div>
                {affectedRanges.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No structured version range was available to display. Review the source
                    advisory before acting on the version alone.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {affectedRanges.map((range) => (
                      <li key={range.id} className="border border-border/60 bg-muted/20 px-4 py-3 font-mono text-xs text-foreground">
                        {formatAffectedRange(range)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </DetailSection> : null}

        {activeTab === 'history' ? <DetailSection label="History">
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing has happened to this advisory risk since it was matched.
                </p>
              ) : (
                <ol className="space-y-4">
                  {events.map((event) => (
                    <li key={event.id} className="flex gap-4">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="text-sm text-foreground">
                          {describeExposureEvent(event.type, event.toState)}
                        </div>
                        {event.note ? (
                          <p className="mt-1 text-sm text-muted-foreground">{event.note}</p>
                        ) : null}
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          <TimeAgo date={event.createdAt} />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </DetailSection> : null}
      </div>

      <ExposureVerificationDialog
        target={verificationTarget}
        onCancel={() => setVerificationTarget(null)}
        onConfirm={() => {
          if (!verificationTarget) return;
          verify.mutate(verificationTarget.id);
          setVerificationTarget(null);
        }}
      />
      <ExposureCorrectionDialog
        open={correctionOpen}
        componentName={component.displayName}
        currentVersion={component.resolvedVersion}
        isSaving={correctionIsPending}
        error={correctionError}
        onClose={() => setCorrectionOpen(false)}
        onSubmit={submitCorrection}
      />
    </DetailPageShell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function formatAffectedRange(range: {
  versionScheme: string;
  introducedVersion: string | null;
  introducedInclusive: boolean | null;
  fixedVersion: string | null;
  fixedInclusive: boolean | null;
}): string {
  const lower = range.introducedVersion
    ? `${range.introducedInclusive === false ? '>' : '>='} ${range.introducedVersion}`
    : 'all earlier versions';
  const upper = range.fixedVersion
    ? `${range.fixedInclusive ? '<=' : '<'} ${range.fixedVersion}`
    : 'with no published fix boundary';
  return `${range.versionScheme}: ${lower}, ${upper}`;
}

function describeExposureEvent(type: string, toState: string | null): string {
  const labels: Record<string, string> = {
    created: 'Potential advisory risk identified',
    notified: 'Notification sent',
    verification_started: 'Focused verification started',
    verification_submitted: 'Verification result submitted',
    confirmed: 'Confirmed exploitable',
    not_reproduced: 'Documented vector not reproduced',
    inconclusive: 'Verification ended inconclusive',
    dismissed: 'Closed by your team',
    resolved: 'No longer matches the observed inventory',
    reopened: 'Match reopened after inventory changed',
    state_changed: toState ? `Status changed to ${humanizeState(toState)}` : 'Status changed',
  };
  return labels[type] ?? (toState ? `Status changed to ${humanizeState(toState)}` : humanizeState(type));
}

function humanizeState(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function observationSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    httpx: 'Website scan',
    agent: 'Security assessment',
    scan_preview: 'Website refresh',
    connected_site: 'Connected site',
    lockfile: 'Repository lockfile',
  };
  return labels[source] ?? humanizeState(source);
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return 'High';
  if (confidence >= 0.65) return 'Medium';
  return 'Low';
}
