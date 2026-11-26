import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Play,
  RefreshCcw,
  Terminal,
  UserPlus,
} from 'lucide-react';
import {
  Badge,
  Button,
  cn,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailRailNote,
  DetailSection,
  RecordTable,
  SeverityBadge,
  StatusTabs,
} from '@null-ai/design-tokens/ui';
import {
  useAssignFindingMutation,
  useCancelFindingDispositionVerificationMutation,
  useFindingDetailQuery,
  useCodeOccurrenceDetailQuery,
  useRiskDetailQuery,
  useFindingDispositionVerificationsQuery,
  useFindingEvidenceQuery,
  useFindingEventsQuery,
  useOrganizationMembersQuery,
  useRequestFindingDispositionVerificationMutation,
  useRetryFindingDispositionVerificationMutation,
  useUpdateFindingMutation,
  useValidateFindingMutation,
} from '@/modules/security-ops/api';
import { CodeSourcePanel, ExposureSourcePanel } from '@/modules/risks/ui/RiskSourcePanels';
import { riskStateLabel } from '@/modules/risks/riskState';
import { CodeFixRail } from '@/modules/risks/ui/CodeFixRail';
import { riskDetailToFinding } from '@/modules/risks/riskToFinding';
import { downloadArtifactBlob } from '@/modules/sessions/api/artifacts';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { toApiError } from '@shared/lib/apiError';
import { isRasterImagePath } from '@shared/lib/reportImages';
import { toastService } from '@shared/services/toastService';
import { TimeAgo } from '@shared/ui/TimeAgo';
import { useOrgPermissions } from '@modules/permissions';
import type {
  Finding,
  FindingEvidence,
  FindingEvent,
  FindingHttpBodyPreview,
  FindingHttpExchange,
  FindingHttpHeader,
} from '@/modules/security-ops/types';
import { CvssScoreBadge } from './components/CvssScoreBadge';
import { OwaspBadge } from './components/OwaspBadge';
import { ValidationBadge } from './components/ValidationBadge';

function getEvidenceAvailability(ev: FindingEvidence) {
  if (ev.sessionId && ev.artifactId) {
    return {
      label: 'FULL ARTIFACT',
      className: 'border-success/30 bg-success/10 text-success',
    };
  }
  if (ev.fileMissing) {
    return {
      label: 'EXCERPT ONLY',
      className: 'border-warning/50 bg-warning/15 text-foreground',
    };
  }
  if (ev.excerpt) {
    return {
      label: 'INLINE EXCERPT',
      className: 'border-info/30 bg-info/10 text-info',
    };
  }
  return {
    label: 'METADATA ONLY',
    className: 'border-border bg-background text-muted-foreground',
  };
}

function isRasterImageEvidence(ev: FindingEvidence): boolean {
  return isRasterImagePath(ev.displayPath ?? ev.path);
}

// Event types are internal enum values, so they get read out as sentences rather
// than shouted back at the reader in SCREAMING_SNAKE.
const FINDING_EVENT_LABELS: Record<string, string> = {
  created: 'Created',
  validation_started: 'Validation started',
  validation_run_started: 'Validation run started',
  validation_state_changed: 'Validation changed',
  status_changed: 'Status changed',
  assigned: 'Assigned',
};

function findingEventLabel(type: string): string {
  return FINDING_EVENT_LABELS[type] ?? type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function findingEventDetail(event: FindingEvent): string | null {
  if (event.detail) return event.detail;
  if (event.note) return event.note;
  if (event.type === 'status_changed' && event.fromStatus && event.toStatus) {
    return `${event.fromStatus} → ${event.toStatus}`;
  }
  return null;
}

function fallbackText(value: string | null | undefined, legacyFallback = 'Not provided.') {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : legacyFallback;
}

/**
 * Heavy fields (fixEffort, remediation, businessImpact, etc.) are intentionally
 * optional on candidate findings. They are filled in by `promote_finding` when
 * the agent flips the finding to reportable. So an empty value is a state
 * signal, not a data-quality bug.
 */
function isCandidateState(state: string | null | undefined): boolean {
  if (!state) return false;
  const lowered = state.toLowerCase();
  return lowered === 'potential' || lowered === 'verifying';
}

function pendingPromotionText(state: string | null | undefined, suffix = 'gets captured when the agent promotes this candidate to reportable.'): string {
  if (isCandidateState(state)) return `Pending — ${suffix}`;
  return 'Not provided.';
}

function formatFixEffort(value: string | null | undefined, state?: string | null) {
  if (value?.trim()) return value.trim().toUpperCase();
  if (isCandidateState(state)) return 'PENDING PROMOTION';
  return 'NOT PROVIDED';
}

function formatServiceLabel(service: Finding['service']) {
  if (!service) return null;
  const base = service.serviceName ?? service.product ?? `${service.protocol}/${service.port}`;
  return service.version ? `${base} ${service.version}` : base;
}

// There is one section label, and it lives in the kit. The local SectionHeading
// this page used to define was a second one, and it had already drifted: no rule
// above, muted instead of bone, two sizes down.
function ProseSection({
  label,
  value,
  fallback,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
}) {
  return (
    <DetailSection label={label}>
      <div className="max-w-[72ch] text-[15px] leading-8 text-foreground">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          components={{
            p: ({ children }) => <p className="mb-5 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-5 list-disc space-y-2 pl-5 last:mb-0">{children}</ul>,
            ol: ({ children }) => <ol className="mb-5 list-decimal space-y-2 pl-5 last:mb-0">{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            code: ({ children }) => (
              <code className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{children}</code>
            ),
          }}
        >
          {fallbackText(value, fallback)}
        </ReactMarkdown>
      </div>
    </DetailSection>
  );
}

function CodeSection({
  label,
  value,
  fallback,
}: {
  label: string;
  value: string | null | undefined;
  fallback?: string;
}) {
  return (
    <DetailSection label={label}>
      <pre className="scrollbar-slim overflow-x-auto border border-border bg-surface-inset p-4 font-mono text-[11.5px] leading-[1.9] text-foreground">
        {fallbackText(value, fallback)}
      </pre>
    </DetailSection>
  );
}

function formatHttpHeaders(headers: FindingHttpHeader[] | undefined): string | null {
  if (!headers?.length) {
    return null;
  }

  return headers
    .map((header) => `${header.name}: ${header.value}${header.redacted ? ' [redacted]' : ''}`)
    .join('\n');
}

function formatHttpBody(body: FindingHttpBodyPreview | null | undefined): string | null {
  if (!body?.text) {
    return null;
  }

  return body.truncated ? `${body.text}\n\n[truncated]` : body.text;
}

function formatHttpRequest(http: FindingHttpExchange | undefined): string {
  if (!http) {
    return 'No request data available.';
  }

  const sections = [`${http.request.method} ${http.request.url}`];
  if (http.request.contentType) {
    sections.push(`Content-Type: ${http.request.contentType}`);
  }

  const headers = formatHttpHeaders(http.request.headers);
  if (headers) {
    sections.push(headers);
  }

  const body = formatHttpBody(http.request.body);
  if (body) {
    sections.push(body);
  }

  return sections.join('\n\n');
}

function formatHttpResponse(http: FindingHttpExchange | undefined): string {
  if (!http) {
    return 'No response data available.';
  }

  const sections = [`Status: ${http.response.statusCode}`];
  if (http.response.contentType) {
    sections.push(`Content-Type: ${http.response.contentType}`);
  }

  const headers = formatHttpHeaders(http.response.headers);
  if (headers) {
    sections.push(headers);
  }

  const body = formatHttpBody(http.response.body);
  if (body) {
    sections.push(body);
  }

  return sections.join('\n\n');
}

function EvidenceViewer({
  ev,
}: {
  ev: FindingEvidence;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(
    ev.sessionId && ev.artifactId && ev.kind !== 'http_exchange',
  ));
  const [error, setError] = useState<string | null>(null);
  const isImage = ev.kind !== 'http_exchange' && isRasterImageEvidence(ev);

  useEffect(() => {
    if (ev.kind === 'http_exchange') return;
    if (!ev.sessionId || !ev.artifactId) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setContent(null);
    setImageUrl(null);
    downloadArtifactBlob(ev.sessionId, ev.artifactId)
      .then(async (blob) => {
        if (isImage) {
          if (typeof URL.createObjectURL !== 'function') {
            throw new Error('Image preview is unavailable in this browser.');
          }
          objectUrl = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          setImageUrl(objectUrl);
          return;
        }

        const text = await blob.text();
        if (!cancelled) {
          setContent(text);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(toApiError(err).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [ev.artifactId, ev.sessionId, ev.kind, isImage]);

  if (ev.kind === 'http_exchange') {
    return (
      <div className="grid grid-cols-1 divide-y divide-border/70 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
        <div className="p-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Request</div>
          <pre className="scrollbar-slim overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground selection:bg-primary selection:text-primary-foreground">
            {formatHttpRequest(ev.http)}
          </pre>

        </div>
        <div className="p-4">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Response</div>
          <pre className="scrollbar-slim overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground selection:bg-primary selection:text-primary-foreground">
            {formatHttpResponse(ev.http)}
          </pre>

        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="relative">
        <pre className="scrollbar-slim overflow-x-auto bg-surface-inset p-4 font-mono text-[11px] leading-relaxed text-foreground">
          {ev.excerpt ?? 'No cached excerpt available.'}
        </pre>

        <div className="absolute inset-0 flex flex-col items-center justify-center bg-destructive/10 text-xs font-bold uppercase text-destructive">
          <span>Error loading full file</span>
          <span className="mt-1 text-[10px]">{error}</span>
        </div>
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="bg-surface-inset p-4">
        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            Loading image evidence...
          </div>
        ) : imageUrl ? (
          <figure className="space-y-3">
            <img
              src={imageUrl}
              alt={`${ev.label ?? 'Evidence'} preview`}
              className="max-h-[560px] w-full border border-border bg-background object-contain"
            />
            {ev.excerpt ? (
              <figcaption className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                {ev.excerpt}
              </figcaption>
            ) : null}
          </figure>
        ) : (
          <pre className="scrollbar-slim overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground">
            {ev.excerpt ?? 'No image preview available.'}
          </pre>
        )}
      </div>
    );
  }

  return (
    <pre className="scrollbar-slim overflow-x-auto bg-surface-inset p-4 font-mono text-[11px] leading-relaxed text-foreground selection:bg-primary selection:text-primary-foreground">
      {loading ? 'LOADING FULL EVIDENCE FILE...' : content ?? ev.excerpt ?? 'No content available.'}
    </pre>

  );
}

type FindingDetailPageProps = {
  backPath?: string;
  backLabel?: string;
  notFoundActionLabel?: string;
};

const dispositionStatusLabel = (
  status: string,
  runStatus?: string | null,
  outcome?: string | null,
): string => {
  if (status === 'running' && (runStatus === 'user_paused' || runStatus === 'system_paused')) {
    return 'Paused';
  }
  if (status === 'launching') return 'Starting';
  if (status === 'completed') {
    if (outcome === 'fixed') return 'Fix verified';
    if (outcome === 'still_present') return 'Still present';
    if (outcome === 'false_positive') return 'False positive verified';
    if (outcome === 'validated') return 'Risk confirmed';
    return 'Inconclusive';
  }
  return status.replaceAll('_', ' ').replace(/\b\w/g, (value) => value.toUpperCase());
};

const isTerminalDispositionStatus = (status: string): boolean =>
  status === 'completed'
  || status === 'failed'
  || status === 'cancelled'
  || status === 'superseded';

export default function FindingDetailPage({
  backPath = '/risks',
  backLabel = 'Back to Risks',
  notFoundActionLabel = 'Return to Inbox',
}: FindingDetailPageProps) {
  const navigate = useNavigate();
  const { id: routeId, occurrenceId } = useParams<{ id: string; occurrenceId: string }>();
  const isOccurrence = Boolean(occurrenceId);
  const id = occurrenceId ?? routeId;
  const paths = useAppPaths();
  const { data: findingRecord, isLoading: findingLoading } = useFindingDetailQuery(id ?? '', {
    enabled: !isOccurrence,
  });
  const { data: canonicalRisk } = useRiskDetailQuery(id ?? '', { enabled: !isOccurrence });
  const { data: occurrence, isLoading: occurrenceLoading } = useCodeOccurrenceDetailQuery(
    occurrenceId ?? '',
    { enabled: isOccurrence },
  );

  const risk = isOccurrence ? occurrence : canonicalRisk;
  const isLoading = isOccurrence ? occurrenceLoading : findingLoading;
  // The page renders a Finding; an occurrence becomes one so it can.
  const finding = findingRecord ?? (risk ? riskDetailToFinding(risk) : undefined);
  const { data: dispositionHistory } = useFindingDispositionVerificationsQuery(id ?? '');
  const { data: events } = useFindingEventsQuery(id ?? '');
  const { data: evidence } = useFindingEvidenceQuery(id ?? '');
  // The Risk rail needs member names to show who owns the Risk. This is a
  // read, not a workflow permission.
  const { data: members } = useOrganizationMembersQuery({ enabled: true });
  const assignFinding = useAssignFindingMutation();
  const updateFinding = useUpdateFindingMutation();
  const validateFinding = useValidateFindingMutation();
  const requestDisposition = useRequestFindingDispositionVerificationMutation();
  const retryDisposition = useRetryFindingDispositionVerificationMutation();
  const cancelDisposition = useCancelFindingDispositionVerificationMutation();
  // Triage covers status changes + assignee + validate/retest. Read-only roles
  // (viewer) see the values but every editable control is disabled.
  const canTriage = useOrgPermissions().has('org.finding.triage');

  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [downloadingEvidenceId, setDownloadingEvidenceId] = useState<string | null>(null);

  const evidenceRows = evidence ?? [];
  const availableMembers = members ?? [];
  const evidenceStats = {
    total: evidenceRows.length,
    downloadable: evidenceRows.filter((ev) => Boolean(ev.sessionId && ev.artifactId)).length,
    excerptOnly: evidenceRows.filter((ev) => Boolean(ev.fileMissing)).length,
    inlineExcerpt: evidenceRows.filter((ev) => !ev.fileMissing && !ev.artifactId && Boolean(ev.excerpt)).length,
  };
  const evidenceSummary = finding?.reviewMeta?.evidenceSummary;
  const hasWeakProof = evidenceSummary
    ? evidenceSummary.downloadableArtifactCount === 0
      && evidenceSummary.structuredHttpCount === 0
    : evidenceStats.downloadable === 0
      && evidenceRows.every((item) => item.kind !== 'http_exchange');
  const showValidationRetry = finding?.state === 'not_reproduced';
  const showFalsePositiveAction = finding?.state !== 'dismissed';
  const showValidateAction =
    showValidationRetry
    || (finding?.state === 'potential' && hasWeakProof);
  const activeDisposition = dispositionHistory?.active ?? null;
  const latestDisposition = dispositionHistory?.latest ?? activeDisposition;
  const dispositionRequester = latestDisposition
    ? availableMembers.find((member) => member.userId === latestDisposition.requestedByUserId)
    : null;
  const dispositionCanceller = latestDisposition?.cancelledByUserId
    ? availableMembers.find((member) => member.userId === latestDisposition.cancelledByUserId)
    : null;

  useEffect(() => {
    if (!finding) return;
    setSelectedAssignee(finding.assignedTo ?? '');
  }, [finding]);

  const handleDownloadEvidence = async (params: {
    evidenceId?: string;
    sessionId?: string;
    artifactId?: string;
    path: string;
  }) => {
    if (!params.sessionId || !params.artifactId) {
      toastService.error('Download unavailable', 'Raw evidence file is not available for this risk entry.');
      return;
    }

    const rowId = params.evidenceId ?? `${params.sessionId}:${params.artifactId}`;
    setDownloadingEvidenceId(rowId);
    try {
      const blob = await downloadArtifactBlob(params.sessionId, params.artifactId);
      const filename = params.path.split('/').pop() || 'evidence.txt';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toastService.error('Download Failed', toApiError(error).message);
    } finally {
      setDownloadingEvidenceId(null);
    }
  };

  const handleCopyFixPrompt = () => {
    if (!finding) return;
    let prompt = `## Security Risk: ${finding.title}\n`;
    prompt += `Severity: ${finding.severity?.toUpperCase() ?? 'N/A'}\n`;
    if (finding.owaspCategory) prompt += `OWASP: ${finding.owaspCategory}\n`;
    if (finding.cweIds?.length) prompt += `CWE: ${finding.cweIds.join(', ')}\n`;
    prompt += `\n### Summary\n${finding.summary ?? 'N/A'}\n`;
    if (finding.businessImpact) prompt += `\n### Business Impact\n${finding.businessImpact}\n`;
    if (finding.technicalAnalysis) prompt += `\n### Technical Analysis\n${finding.technicalAnalysis}\n`;
    if (finding.pocDescription) prompt += `\n### How to Reproduce\n${finding.pocDescription}\n`;
    if (finding.pocScriptCode) prompt += `\n### PoC\n\`\`\`\n${finding.pocScriptCode}\n\`\`\`\n`;
    if (finding.assumptions) prompt += `\n### Assumptions\n${finding.assumptions}\n`;
    prompt += `\n### Remediation\n${finding.remediation ?? 'N/A'}\n`;
    if (finding.codeLocations?.length) {
      prompt += `\n### Affected Code Locations\n`;
      finding.codeLocations.forEach((loc, idx) => {
        prompt += `\n#### Location ${idx + 1}${loc.label ? `: ${loc.label}` : ''}\n`;
        prompt += `Path: ${loc.pathKind === 'repository' ? `${loc.repository ?? 'unknown'} @ ${loc.ref ?? 'HEAD'}` : 'workspace'} — ${loc.filePath} lines ${loc.startLine}–${loc.endLine}\n`;
        if (loc.fixBefore) prompt += `\nBefore:\n\`\`\`\n${loc.fixBefore}\n\`\`\`\n`;
        if (loc.fixAfter) prompt += `\nAfter:\n\`\`\`\n${loc.fixAfter}\n\`\`\`\n`;
      });
    }
    navigator.clipboard.writeText(prompt)
      .then(() => toastService.success('Copied', 'Fix prompt copied to clipboard.'))
      .catch((err) => toastService.error('Copy Failed', String(err)));
  };

  const handleValidationRunStart = () => {
    if (!finding) return;

    validateFinding.mutate(finding.id, {
      onSuccess: (result) => {
        const runLabel = result.run.displayId ? `#r${result.run.displayId}` : result.run.id.slice(0, 8);
        toastService.success('Validation Started', `${runLabel} is ready for ${finding.title}.`);
        navigate(paths.runDetail(result.run.id));
      },
      onError: (error) => {
        toastService.error('Validation Failed', toApiError(error).message);
      },
    });
  };

  const handleRequestDisposition = (requestedState: 'resolved' | 'dismissed') => {
    if (!finding) return;
    const baseConfirmation =
      requestedState === 'resolved'
        ? 'Resolve and verify?\n\nThe risk stays open until the agent confirms the fix. This starts a normal agent run.'
        : 'Review as false positive?\n\nThe risk keeps its current validation state until the agent confirms the claim is invalid. This starts a normal agent run.';
    const confirmation =
      activeDisposition
      && activeDisposition.requestedState !== requestedState
        ? `${baseConfirmation}\n\nThis will supersede and cancel the active ${activeDisposition.requestedState === 'resolved' ? 'resolution' : 'false-positive'} verification.`
        : baseConfirmation;
    if (!window.confirm(confirmation)) {
      return;
    }
    requestDisposition.mutate(
      {
        findingId: finding.id,
        requestedState,
      },
      {
        onSuccess: () => {
          toastService.success(
            'Verification queued',
            requestedState === 'resolved'
              ? 'The risk stays open until the agent confirms the fix.'
              : 'The validation state stays unchanged until the agent confirms the claim is invalid.',
          );
        },
        onError: (error) => {
          toastService.error('Verification request failed', toApiError(error).message);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background font-mono uppercase tracking-widest text-foreground">
        Loading vulnerability data…
      </div>
    );
  }

  if (!finding) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background font-mono uppercase tracking-widest text-foreground">
        <AlertTriangle className="mb-4 h-12 w-12 text-muted-foreground" />
        <p>Risk Not Found</p>
        <Button onClick={() => navigate(backPath)} className="mt-4" variant="outline">
          {notFoundActionLabel}
        </Button>
      </div>
    );
  }

  const cweValues = finding.cweIds?.length ? finding.cweIds : [finding.cweId].filter(Boolean);
  const cveValues = finding.cveIds?.length ? finding.cveIds : [finding.cveId].filter(Boolean);
  const fixEffortLabel = formatFixEffort(finding.fixEffort, finding.state);
  const remediationFallback = pendingPromotionText(finding.state, 'Remediation steps get filled in when the agent promotes this candidate to reportable.');
  const heavyFieldFallback = pendingPromotionText(finding.state);
  const businessImpactFallback = finding.businessImpact ? undefined : heavyFieldFallback;
  const technicalAnalysisFallback = finding.technicalAnalysis ? undefined : heavyFieldFallback;
  const assumptionsFallback = finding.assumptions ? undefined : heavyFieldFallback;
  const effectiveState = finding.state;
  const endpointLabel = finding.endpoint ? `${finding.endpoint.method} ${finding.endpoint.url}` : null;
  const serviceLabel = formatServiceLabel(finding.service);
  const evidenceTimelineRows = [...evidenceRows].sort((left, right) => {
    const leftTime = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightTime = right.createdAt ? Date.parse(right.createdAt) : 0;
    return leftTime - rightTime;
  });
  // The rail is a workflow, not a properties list: a verification in flight, the
  // status and assignee controls, and the page's verbs. Everything that merely
  // *described* the finding (Severity & Status, Risk Signals, Target) was a
  // second rendering of the header or of Affected Context, and is gone.
  const rail = (
    <DetailRailBlock>
          {/* A code Risk's one verb. The rest of its detail is the same
              anatomy as any other Risk, so only the action is conditional. */}
          {risk?.sourceKind === 'code_review' ? (
            <div className="border-b border-border pb-6">
              <CodeFixRail risk={risk} />
            </div>
          ) : null}
          {latestDisposition ? (
            <div className="border-b border-border pb-6">
              <h3 className="mb-4 border-b border-border/70 pb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                Disposition Verification
              </h3>
              <div className="space-y-3 border-l-2 border-l-border pl-4">
                <div className="flex items-center justify-between gap-3">
                  <Badge className="rounded-none border border-border font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {dispositionStatusLabel(
                      latestDisposition.status,
                      latestDisposition.runStatus,
                      latestDisposition.outcome,
                    )}
                  </Badge>
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">
                    Attempt {latestDisposition.attemptNumber}
                  </span>
                </div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  Requested by{' '}
                  <span className="font-semibold text-foreground">
                    {dispositionRequester?.fullName
                      ?? dispositionRequester?.email
                      ?? latestDisposition.requestedByUserId.slice(0, 8)}
                  </span>{' '}
                  <span className="font-semibold text-foreground">
                    {latestDisposition.requestedState === 'resolved'
                      ? 'resolution'
                      : 'false-positive review'}
                  </span>{' '}
                  <TimeAgo date={latestDisposition.createdAt} />.
                </div>
                {latestDisposition.status === 'cancelled' ? (
                  <div className="text-[11px] leading-relaxed text-muted-foreground">
                    Cancelled by{' '}
                    <span className="font-semibold text-foreground">
                      {dispositionCanceller?.fullName
                        ?? dispositionCanceller?.email
                        ?? latestDisposition.cancelledByUserId?.slice(0, 8)
                        ?? 'an operator'}
                    </span>
                    {latestDisposition.cancelledAt ? (
                      <> <TimeAgo date={latestDisposition.cancelledAt} />.</>
                    ) : null}
                  </div>
                ) : null}
                {latestDisposition.runId ? (
                  <Link
                    to={paths.runDetail(latestDisposition.runId)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground/50"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Run{' '}
                    {latestDisposition.runDisplayId
                      ? `#r${latestDisposition.runDisplayId}`
                      : latestDisposition.runId.slice(0, 8)}
                    {' '}· live activity, usage, and cost
                  </Link>
                ) : null}
                {latestDisposition.waitReason
                  || latestDisposition.failureReason
                  || latestDisposition.outcomeReason
                  || latestDisposition.blockerCode ? (
                  <div className="border-l-2 border-warning/60 pl-3 text-[11px] leading-relaxed text-muted-foreground">
                    {latestDisposition.failureReason
                      ?? latestDisposition.outcomeReason
                      ?? latestDisposition.waitReason
                      ?? latestDisposition.blockerCode}
                  </div>
                ) : null}
                {canTriage && activeDisposition ? (
                  <Button
                    variant="outline"
                    className="w-full justify-center rounded-none border-border text-[10px] uppercase tracking-widest hover:border-destructive hover:text-destructive"
                    disabled={cancelDisposition.isPending}
                    onClick={() => {
                      if (!window.confirm('Cancel this verification and its linked Run?')) return;
                      cancelDisposition.mutate({
                        findingId: finding.id,
                        verificationId: activeDisposition.id,
                      }, {
                        onSuccess: () => toastService.success('Verification cancelled', 'Canonical risk state was not changed.'),
                        onError: (error) => toastService.error('Cancel failed', toApiError(error).message),
                      });
                    }}
                  >
                    {cancelDisposition.isPending ? 'Cancelling...' : 'Cancel Verification'}
                  </Button>
                ) : null}
                {canTriage
                  && isTerminalDispositionStatus(latestDisposition.status)
                  && (
                    latestDisposition.status !== 'completed'
                    || latestDisposition.outcome === 'inconclusive'
                  ) ? (
                  <Button
                    variant="outline"
                    className="w-full justify-center rounded-none border-border text-[10px] uppercase tracking-widest hover:border-foreground/40 hover:text-foreground"
                    disabled={retryDisposition.isPending}
                    onClick={() => retryDisposition.mutate({
                      findingId: finding.id,
                      verificationId: latestDisposition.id,
                    }, {
                      onSuccess: () => toastService.success('Retry queued', 'A new linked attempt was created.'),
                      onError: (error) => toastService.error('Retry failed', toApiError(error).message),
                    })}
                  >
                    <RefreshCcw className="mr-2 h-3.5 w-3.5" />
                    {retryDisposition.isPending ? 'Queuing Retry...' : 'Retry Verification'}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
            <div className="pb-6">
              <h3 className="mb-4 border-b border-border/70 pb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
                Workflow
              </h3>

              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
                    Current Status
                  </label>
                  <select
                    data-tour="finding-status"
                    value={effectiveState}
                    disabled={!canTriage}
                    title={canTriage ? undefined : 'Your role does not permit triaging risks.'}
                    onChange={(e) => {
                      if (!canTriage) return;
                      const nextState = e.target.value as Finding['state'];
                      if (
                        activeDisposition
                        && !window.confirm(
                          'This will supersede and cancel the active verification. Continue?',
                        )
                      ) {
                        return;
                      }
                      updateFinding.mutate({ id: finding.id, state: nextState });
                    }}
                    className="h-10 w-full border border-border bg-input px-3 text-xs uppercase text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                      {/* Resolved and dismissed are earned, not chosen: each
                          needs a verification run to prove it. */}
                      <option value="confirmed" className="bg-background">Confirmed</option>
                      <option value="accepted" className="bg-background">Accepted</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground">
                    Assignee
                  </label>
                  <div className="flex gap-2">
                    <select
                      data-tour="finding-assign"
                      value={selectedAssignee}
                      disabled={!canTriage}
                      onChange={(e) => setSelectedAssignee(e.target.value)}
                      className="h-10 w-full border border-border bg-input px-3 text-xs uppercase text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <option value="" className="bg-background">Unassigned</option>
                      {availableMembers.map((member) => (
                        <option key={member.userId} value={member.userId} className="bg-background">
                          {member.fullName ?? member.email}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-10 w-10 border-border hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
                      onClick={() => {
                        if (!canTriage) {
                          return;
                        }

                        assignFinding.mutate({ id: finding.id, userId: selectedAssignee || null });
                      }}
                      disabled={!canTriage || assignFinding.isPending}
                      title={canTriage ? 'Assign User' : 'Your role does not permit triaging risks.'}
                    >
                      <UserPlus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {showValidationRetry ? (
                  <DetailRailNote tone="warning" title="Validation did not reproduce">
                    Review prerequisites, rerun validation, or mark this as a false positive if the
                    risk remains unreproducible.
                  </DetailRailNote>
                ) : null}

                {canTriage && showValidateAction ? (
                  <Button
                    className="w-full justify-center rounded-none text-[10px] uppercase tracking-widest"
                    onClick={handleValidationRunStart}
                    disabled={validateFinding.isPending || requestDisposition.isPending}
                  >
                    <Play className="mr-2 h-3.5 w-3.5" />
                    {validateFinding.isPending
                      ? 'Starting Validation...'
                      : showValidationRetry
                        ? 'Run Validation Again'
                        : 'Validate Risk'}
                  </Button>
                ) : null}

                {/* Resolution is a request, not a state you pick: the risk
                    stays open until a verification run proves the fix. */}
                {canTriage && finding.state === 'confirmed' ? (
                  <Button
                    variant="outline"
                    className="w-full justify-center rounded-none border-border text-[10px] uppercase tracking-widest hover:border-foreground/40 hover:text-foreground"
                    onClick={() => handleRequestDisposition('resolved')}
                    disabled={
                      requestDisposition.isPending
                      || updateFinding.isPending
                      || validateFinding.isPending
                    }
                  >
                    Request Resolution
                  </Button>
                ) : null}

                {canTriage && showFalsePositiveAction ? (
                  <Button
                    variant="outline"
                    className="w-full justify-center rounded-none border-border text-[10px] uppercase tracking-widest hover:border-foreground/40 hover:text-foreground"
                    onClick={() => handleRequestDisposition('dismissed')}
                    disabled={
                      requestDisposition.isPending
                      || updateFinding.isPending
                      || validateFinding.isPending
                    }
                  >
                    Review as False Positive
                  </Button>
                ) : null}

                <DetailRailNote title="Validation guidance">
                    {showValidationRetry
                      ? 'The last validation run did not reproduce this risk. Resolve blockers if any, then rerun validation or mark it as a false positive.'
                      : finding.state === 'confirmed'
                        ? 'After a fix lands, request resolution. The risk stays open until a verification run confirms the fix.'
                        : finding.state === 'verifying'
                          ? 'A validation run is already tracking this risk. Review the outcome before taking further action.'
                          : showValidateAction
                            ? 'This risk was reported without durable proof. Use validate to confirm it or determine whether it is a false positive.'
                            : 'This risk already has durable proof attached and does not need a manual validation run by default.'}
                  </DetailRailNote>
              </div>
            </div>
    </DetailRailBlock>
  );

  return (
    <DetailPageShell
      backLink={<DetailBackLink label={backLabel} onClick={() => navigate(backPath)} />}
      displayId={
        <>
          ID {finding.id.split('-')[0]} · Discovered <TimeAgo date={finding.firstSeenAt} />
        </>
      }
      rail={rail}
    >
      <div className="space-y-6">
        <DetailHeader
          badges={
            <>
              <SeverityBadge severity={finding.severity} />
              {/* One lifecycle: the canonical state when it has loaded, the
                  derived validation badge only until it does. */}
              {risk ? (
                <span className="border border-border px-2 py-1 text-xs text-muted-foreground">
                  {riskStateLabel(risk.state)}
                </span>
              ) : (
                <ValidationBadge state={finding.state} />
              )}
              {finding.cvssScore != null ? (
                <CvssScoreBadge score={finding.cvssScore} vector={finding.cvssVector} />
              ) : null}
            </>
          }
          title={finding.title}
          subline={[
            finding.assetId ? (
              <Link
                key="asset"
                to={paths.assetDetail(finding.assetId)}
                className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground/50"
              >
                {finding.assetValue}
              </Link>
            ) : (
              <span key="asset" className="font-medium text-foreground">{finding.assetValue}</span>
            ),
            endpointLabel ?? serviceLabel,
            finding.scopeName,
            <span key="seen">
              Last seen <TimeAgo date={finding.lastSeenAt} />
            </span>,
          ]}
        />

        {/* The rail's verb owns the page's one yellow, so the marker is bone. */}
        <StatusTabs
          tone="bone"
          aria-label="Risk sections"
          value={activeTab}
          onChange={setActiveTab}
          itemAttributes={(item) => ({ 'data-tour': `finding-tab-${item.value}` })}
          items={[
            { value: 'overview', label: 'Overview' },
            { value: 'evidence', label: 'Evidence' },
            { value: 'remediation', label: 'Remediation' },
            { value: 'history', label: 'History' },
          ]}
        />

            <div className="min-h-[400px] max-w-[940px]">
              {activeTab === 'overview' ? (
                <div className="animate-in space-y-8 fade-in duration-300">
                  <ProseSection
                    label="TL;DR"
                    value={finding.summary ?? finding.description}
                    fallback="No TL;DR provided."
                  />

                  <ProseSection label="Business Impact" value={finding.businessImpact} fallback={businessImpactFallback} />

                  <ProseSection label="Technical Analysis" value={finding.technicalAnalysis} fallback={technicalAnalysisFallback} />

                  <ProseSection label="Assumptions" value={finding.assumptions} fallback={assumptionsFallback} />

                  <DetailSection label="Affected Context">
                    <div className="divide-y divide-border/70 border-b border-border/70">
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 py-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Asset</div>
                        <div>
                          <div className="text-sm font-semibold text-foreground">{finding.assetValue}</div>
                          <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">{finding.assetKind}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 py-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Endpoint</div>
                        <div>
                          <div className="break-all text-sm font-semibold text-foreground">{finding.endpoint?.url ?? 'No linked endpoint'}</div>
                          <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                            {finding.endpoint?.method ?? 'Asset-level risk'}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 py-4">
                        <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Service</div>
                        <div>
                          <div className="text-sm font-semibold text-foreground">{serviceLabel ?? 'No linked service'}</div>
                          <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                            {finding.service ? `${finding.service.protocol}/${finding.service.port}` : 'Unspecified'}
                          </div>
                        </div>
                      </div>
                        <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-4 py-4">
                          <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Scope</div>
                          <div>
                            <div className="text-sm font-semibold text-foreground">{finding.scopeName ?? 'Unknown scope'}</div>
                            <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                              Risk ID {finding.id.split('-')[0]}
                            </div>
                          </div>
                        </div>
                    </div>
                  </DetailSection>

                  {cweValues.length > 0 || cveValues.length > 0 || finding.owaspCategory ? (
                    <DetailSection label="Classification">
                      <div className="flex flex-wrap gap-2">
                        {cweValues.map((cwe) => (
                          <Badge
                            key={cwe}
                            className="rounded-none border border-border bg-background font-mono text-[10px] uppercase tracking-wider text-foreground"
                          >
                            {cwe}
                          </Badge>
                        ))}
                        {cveValues.map((cve) => (
                          <Badge
                            key={cve}
                            className="rounded-none border border-destructive/30 bg-destructive/10 font-mono text-[10px] uppercase tracking-wider text-destructive"
                          >
                            {cve}
                          </Badge>
                        ))}
                        {finding.owaspCategory ? <OwaspBadge category={finding.owaspCategory} /> : null}
                      </div>
                    </DetailSection>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'evidence' ? (
                <div className="animate-in space-y-8 fade-in duration-300">
                  {/* A seam divides, it never encloses — and the counts speak for
                      themselves, so the old proof-strength badge (two vocabularies
                      for one idea, per audit 5B.3) is gone rather than restyled. */}
                  <div className="border-t border-border/60 pt-5">
                    <div className="flex flex-wrap items-center gap-x-8 gap-y-2 font-mono text-[12px] text-muted-foreground">
                      <span>
                        Evidence rows <span className="text-foreground">{evidenceStats.total}</span>
                      </span>
                      <span>
                        Retained artifacts <span className="text-foreground">{evidenceStats.downloadable}</span>
                      </span>
                      <span>
                        Excerpts{' '}
                        <span className="text-foreground">
                          {evidenceStats.excerptOnly + evidenceStats.inlineExcerpt}
                        </span>
                      </span>
                    </div>
                    <p className="mt-4 max-w-[72ch] text-[15px] leading-relaxed text-foreground/85">
                      {evidenceStats.downloadable > 0
                        ? 'A retained artifact is attached, so there is durable proof to review or download.'
                        : evidenceStats.excerptOnly + evidenceStats.inlineExcerpt > 0
                          ? 'Only excerpts are attached. A targeted validation run should try to capture durable proof.'
                          : 'Nothing durable is attached yet. Validate before treating this as confirmed.'}
                    </p>
                  </div>

                  <ProseSection label="Reproduction" value={finding.pocDescription} />

                  <CodeSection label="PoC Script" value={finding.pocScriptCode} />

                  <DetailSection label="Evidence Chain">
                    {evidenceTimelineRows.length === 0 ? (
                      <div className="border border-dashed border-border/70 bg-muted/20 p-12 text-center">
                        <Terminal className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                        <p className="text-xs uppercase tracking-widest text-muted-foreground">
                          No retained artifact or proof excerpt
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-5">
                        {evidenceTimelineRows.map((ev) => {
                          const availability = getEvidenceAvailability(ev);
                          const rowId = ev.id ?? `${ev.sessionId ?? 'inline'}:${ev.artifactId ?? ev.path}`;

                          return (
                            <div key={rowId} className="overflow-hidden border-b border-border/60 last:border-b-0">
                              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                                    {ev.label ?? 'Evidence'}
                                  </span>
                                  <Badge
                                    className={cn(
                                      'rounded-none border font-mono text-[9px] uppercase tracking-wider',
                                      availability.className,
                                    )}
                                  >
                                    {availability.label}
                                  </Badge>
                                  {ev.createdAt ? (
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                      <TimeAgo date={ev.createdAt} />
                                    </span>
                                  ) : null}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  {ev.sessionId && ev.artifactId ? (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 border-border px-2 text-[10px] uppercase tracking-wider hover:border-foreground/40 hover:text-foreground"
                                      onClick={() =>
                                        void handleDownloadEvidence({
                                          evidenceId: ev.id,
                                          sessionId: ev.sessionId,
                                          artifactId: ev.artifactId,
                                          path: ev.path,
                                        })
                                      }
                                      disabled={downloadingEvidenceId === rowId}
                                    >
                                      <Download className="mr-1 h-3 w-3" />
                                      {downloadingEvidenceId === rowId ? 'Downloading' : 'Download'}
                                    </Button>
                                  ) : null}
                                </div>
                              </div>

                              <div className="border-b border-border/70 bg-surface-1/30 px-5 py-3 text-[11px] uppercase tracking-wider text-muted-foreground">
                                {ev.displayPath ?? ev.path}
                              </div>

                              <div className="relative">
                                <EvidenceViewer ev={ev} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </DetailSection>
                </div>
              ) : null}

              {activeTab === 'remediation' ? (
                <div className="animate-in space-y-8 fade-in duration-300">
                  <DetailSection
                    label="Fix"
                    action={
                      finding.summary ? (
                        <Button
                          variant="outline"
                          data-tour="finding-copy-fix"
                          onClick={() => handleCopyFixPrompt()}
                          className="h-8 border-border bg-muted px-4 text-xs font-semibold uppercase tracking-widest text-foreground hover:bg-muted hover:text-foreground"
                        >
                          Copy Fix Prompt
                        </Button>
                      ) : null
                    }
                  >
                    <div className="flex flex-wrap items-center gap-3 border-b border-border/70 pb-5">
                      <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-foreground">Fix Effort</span>
                      <Badge className="rounded-none border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                        {fixEffortLabel}
                      </Badge>
                    </div>
                    <div className="mt-6 text-[15px] leading-8 text-foreground">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm, remarkBreaks]}
                        components={{
                          p: ({ children }) => <p className="mb-5 last:mb-0">{children}</p>,
                          ul: ({ children }) => <ul className="mb-5 list-disc space-y-2 pl-5 last:mb-0">{children}</ul>,
                          ol: ({ children }) => <ol className="mb-5 list-decimal space-y-2 pl-5 last:mb-0">{children}</ol>,
                          li: ({ children }) => <li>{children}</li>,
                          code: ({ children }) => (
                            <code className="rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">{children}</code>
                          ),
                        }}
                      >
                        {fallbackText(finding.remediation, remediationFallback)}
                      </ReactMarkdown>
                    </div>
                  </DetailSection>

                  {finding.codeLocations && finding.codeLocations.length > 0 && (
                    <DetailSection label="Affected Code">
                      <div className="space-y-6">
                        {finding.codeLocations.map((loc, idx) => (
                          <div key={idx} className="border-b border-border/60 py-5 last:border-b-0">
                            <div className="mb-4 flex flex-wrap items-center gap-3">
                              <Badge className="rounded-none border border-border/70 bg-background text-[10px] uppercase tracking-wider text-muted-foreground">
                                {loc.pathKind === 'repository' ? loc.repository : 'Workspace'}
                              </Badge>
                              <span className="text-xs font-mono text-muted-foreground">
                                {loc.filePath} <span className="text-muted-foreground">L{loc.startLine}-{loc.endLine}</span>
                              </span>
                            </div>
                            {loc.fixBefore && (
                              <div className="mb-4">
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Context Before</div>
                                <pre className="scrollbar-slim overflow-x-auto border-l-2 border-border bg-background/50 p-3 pl-4 font-mono text-[11px] text-muted-foreground">
                                  {loc.fixBefore}
                                </pre>

                              </div>
                            )}
                            {loc.fixAfter && (
                              <div>
                                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Fix Suggestion</div>
                                <pre className="scrollbar-slim overflow-x-auto rounded border border-success/30 bg-success/10 p-3 font-mono text-[11px] text-success">
                                  {loc.fixAfter}
                                </pre>

                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </DetailSection>
                  )}
                </div>
              ) : null}

              {/* Source proof. One lifecycle, but an assessment, a code
                  review and a verified advisory do not prove a Risk the same
                  way, so only the evidence branches. */}
              {activeTab === 'overview' && risk ? (
                <div className="mt-8 space-y-8">
                  <CodeSourcePanel risk={risk} />
                  <ExposureSourcePanel risk={risk} />
                </div>
              ) : null}

              {activeTab === 'history' ? (
                <DetailSection label={`History (${(events ?? []).length})`}>
                  {(events ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No events recorded yet.</p>
                  ) : (
                    // A history is a list of events, so it is the one data table.
                    // The bespoke timeline it replaces gave every row a yellow
                    // label and a yellow square — the live mark, spent on things
                    // that already happened.
                    <RecordTable
                      rows={events ?? []}
                      getRowKey={(event) => event.id}
                      titleWidth="minmax(0,1.4fr)"
                      title={(event) => findingEventLabel(event.type)}
                      subtitle={(event) => findingEventDetail(event)}
                      columns={[
                        {
                          key: 'at',
                          header: 'When',
                          width: '160px',
                          mono: true,
                          align: 'end',
                          render: (event) => <TimeAgo date={event.createdAt} />,
                          showOnMobile: true,
                        },
                      ]}
                    />
                  )}
                </DetailSection>
              ) : null}
            </div>
      </div>
    </DetailPageShell>
  );
}
