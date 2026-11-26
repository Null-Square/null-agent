import {
  useAssetDetailQuery,
  useAssetEndpointsQuery,
  useAssetFindingsQuery,
  useAssetScanCoverageQuery,
  useAssetServicesQuery,
  useAssetSubdomainsQuery,
  useAssetTechQuery,
  useRunsQuery,
} from '@/modules/security-ops/api';
import type { AssetScanCoverage } from '@/modules/security-ops/types';
import {
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailSection,
  ListEmptyState,
  ListMeta,
  ListMetrics,
  RecordTable,
  StatusTabs,
  severityTone,
  FindingStatusBadge,
  RunStatusBadge,
} from '@null-ai/design-tokens/ui';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import { TimeAgo } from '@shared/ui/TimeAgo';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssetKindBadge } from './components/AssetKindBadge';
import { AssetExposuresTab } from '@/modules/exposures/ui/components/AssetExposuresTab';

// CVSS is graded by the severity ramp — see FindingsPage.
function compactFindingTag(values: Array<string | null | undefined>, prefix: string) {
  const normalized = values.filter((value): value is string => Boolean(value));
  if (normalized.length === 0) return null;
  return normalized.length === 1 ? normalized[0] : `${prefix} ${normalized.length}`;
}

// A section names its own rows, so the table below it does not repeat the name
// in a column header. The count rides the label instead of a separate stat.
const sectionLabel = (label: string, count: number) => (
  <span className="flex items-baseline gap-2.5">
    {label}
    <span className="font-mono text-[12px] font-normal tabular-nums text-muted-foreground/50">{count}</span>
  </span>
);

// Scan coverage is a handful of facts, not a card. Open at every edge.
function ScanCoverage({ coverage }: { coverage: AssetScanCoverage | null }) {
  if (!coverage) {
    return <p className="text-sm text-muted-foreground">No broad scan coverage recorded.</p>;
  }

  const facts: Array<[string, ReactNode]> = [
    ['Status', coverage.status],
    ['Last assessed', <TimeAgo key="assessed" date={coverage.assessedAt} />],
  ];
  if (coverage.endpointsDiscovered != null) {
    facts.push(['Endpoints found', String(coverage.endpointsDiscovered)]);
  }
  if (coverage.findingsCreated != null) {
    facts.push(['Tested risks created', String(coverage.findingsCreated)]);
  }
  if (coverage.technologiesDetected != null) {
    facts.push(['Technologies detected', String(coverage.technologiesDetected)]);
  }

  return (
    <dl className="grid grid-cols-2 gap-x-10 gap-y-5 sm:grid-cols-3">
      {facts.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
          <dd className="font-mono text-[13px] text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type AssetDetailPageProps = {
  backPath?: string;
  backLabel?: string;
  notFoundActionLabel?: string;
};

export default function AssetDetailPage({
  backPath = '/assets',
  backLabel = 'Back to Assets',
  notFoundActionLabel = 'Return to Inventory',
}: AssetDetailPageProps) {
  const { scopes } = useScope();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { data: asset, isLoading } = useAssetDetailQuery(id ?? '');
  const { data: services } = useAssetServicesQuery(id ?? '');
  const { data: endpoints } = useAssetEndpointsQuery(id ?? '');
  const { data: findings } = useAssetFindingsQuery(id ?? '');
  const { data: subdomains } = useAssetSubdomainsQuery(id ?? '');
  const { data: techs } = useAssetTechQuery(id ?? '');
  const { data: scanCoverage } = useAssetScanCoverageQuery(id ?? '');
  const { data: allRuns } = useRunsQuery({ scopeId: asset?.scopeId }, { enabled: Boolean(asset?.scopeId) });
  const [activeTab, setActiveTab] = useState('overview');

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <span className="ns-live-mark mr-3" aria-hidden />
        Loading asset
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="flex min-h-[80vh] flex-col items-center justify-center gap-4 bg-background">
        <p className="text-lg font-semibold text-foreground">Asset not found</p>
        <Link to={backPath} className="text-sm font-medium text-primary hover:underline">
          {notFoundActionLabel}
        </Link>
      </div>
    );
  }

  const scopeName = scopes.find((scope) => scope.id === asset.scopeId)?.name ?? asset.scopeId ?? 'Unknown Scope';
  const severityCounts = (findings ?? []).reduce<Record<string, number>>((acc, finding) => {
    acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
    return acc;
  }, {});

  const serviceRows = services ?? [];
  const endpointRows = endpoints ?? [];
  const subdomainRows = subdomains ?? [];
  const techRows = techs ?? [];
  const findingRows = findings ?? [];
  const runRows = allRuns ?? [];

  return (
    <DetailPageShell
      backLink={<DetailBackLink label={backLabel} onClick={() => navigate(backPath)} />}
      displayId={`ID ${String(asset.id).split('-')[0]}`}
      // No rail. An asset has no verb of its own — tracking moved to the agent —
      // so a rail here could only restate the overview. Its four facts live in
      // the subline (scope, seen) and in the section counts (mapped, findings).
    >
      <DetailHeader
        badges={
          <>
            <AssetKindBadge kind={asset.kind} />
          </>
        }
        title={<span className="break-all">{asset.value}</span>}
        subline={[
          scopeName,
          <span key="first">
            First seen <TimeAgo date={String(asset.firstSeenAt)} />
          </span>,
          <span key="last">
            Last seen <TimeAgo date={asset.lastSeenAt} />
          </span>,
          asset.tags.length > 0 ? asset.tags.join(' · ') : null,
        ]}
      />

      {/* Tabs are for depth. On a detail page the rail owns the yellow, so the
          marker goes bone. */}
      <StatusTabs
        className="mt-10"
        tone="bone"
        aria-label="Asset sections"
        value={activeTab}
        onChange={setActiveTab}
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'findings', label: 'Tested risks', count: findingRows.length },
          { value: 'exposures', label: 'Advisory risks' },
          { value: 'runs', label: 'Assessments', count: runRows.length },
        ]}
      />

      <div className="mt-8 min-h-[400px]">
        {activeTab === 'overview' ? (
          <div className="space-y-10">
            <ListMetrics
              label="Risk posture"
              items={[
                { label: 'Critical', value: severityCounts['critical'] ?? 0, severity: 'critical' },
                { label: 'High', value: severityCounts['high'] ?? 0, severity: 'high' },
                { label: 'Medium', value: severityCounts['medium'] ?? 0, severity: 'medium' },
                { label: 'Low', value: severityCounts['low'] ?? 0, severity: 'low' },
              ]}
            />

            <DetailSection label={sectionLabel('Services', serviceRows.length)}>
              {serviceRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No open services detected.</p>
              ) : (
                <RecordTable
                  rows={serviceRows}
                  getRowKey={(service) => service.id}
                  title={(service) => `${service.serviceName || 'unknown'} / ${service.protocol}`}
                  subtitle={(service) =>
                    [service.product || 'unknown product', service.version].filter(Boolean).join(' ')
                  }
                  columns={[
                    {
                      key: 'port',
                      header: 'Port',
                      width: '90px',
                      mono: true,
                      align: 'end',
                      render: (service) => service.port,
                      showOnMobile: true,
                    },
                    {
                      key: 'evidence',
                      header: 'Evidence',
                      width: '110px',
                      mono: true,
                      align: 'end',
                      render: (service) => service.evidence?.length ?? 0,
                    },
                  ]}
                />
              )}
            </DetailSection>

            {/* The count is what the section renders — never a separate total
                from the asset record, which is how "Endpoints 18" ended up
                sitting above "No endpoint observations recorded". */}
            <DetailSection label={sectionLabel('Endpoints', endpointRows.length)}>
              {endpointRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No endpoint observations recorded.</p>
              ) : (
                <RecordTable
                  rows={endpointRows}
                  getRowKey={(endpoint) => endpoint.id}
                  title={(endpoint) => endpoint.url}
                  subtitle={(endpoint) => endpoint.title ?? null}
                  columns={[
                    {
                      key: 'method',
                      header: 'Method',
                      width: '100px',
                      mono: true,
                      render: (endpoint) => endpoint.method,
                      showOnMobile: true,
                    },
                    {
                      key: 'status',
                      header: 'Status',
                      width: '90px',
                      mono: true,
                      align: 'end',
                      render: (endpoint) => endpoint.statusCode ?? '—',
                    },
                  ]}
                />
              )}
            </DetailSection>

            <DetailSection label={sectionLabel('Candidate subdomains', subdomainRows.length)}>
              {subdomainRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No candidate subdomains attached.</p>
              ) : (
                <RecordTable
                  rows={subdomainRows}
                  getRowKey={(subdomain) => subdomain.id}
                  title={(subdomain) => subdomain.hostname}
                  columns={[
                    {
                      key: 'resolved',
                      header: 'Resolves to',
                      width: 'minmax(0,1fr)',
                      mono: true,
                      align: 'end',
                      render: (subdomain) =>
                        subdomain.resolvedIps.length > 0
                          ? subdomain.resolvedIps.join(', ')
                          : 'passive discovery',
                      showOnMobile: true,
                    },
                  ]}
                />
              )}
            </DetailSection>

            <DetailSection label={sectionLabel('Technology', techRows.length)}>
              {techRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tech fingerprints recorded.</p>
              ) : (
                <RecordTable
                  rows={techRows}
                  getRowKey={(tech) => tech.id}
                  title={(tech) => tech.product}
                  subtitle={(tech) => [tech.version, tech.category].filter(Boolean).join(' · ') || null}
                  columns={[
                    {
                      key: 'confidence',
                      header: 'Confidence',
                      width: '120px',
                      mono: true,
                      align: 'end',
                      render: (tech) => (tech.confidence != null ? `${tech.confidence}%` : '—'),
                      showOnMobile: true,
                    },
                  ]}
                />
              )}
            </DetailSection>

            <DetailSection label="Scan coverage">
              <ScanCoverage coverage={scanCoverage ?? null} />
            </DetailSection>
          </div>
        ) : null}

        {activeTab === 'exposures' ? <AssetExposuresTab assetValue={asset.value} /> : null}

        {activeTab === 'findings' ? (
          findingRows.length === 0 ? (
            <ListEmptyState
              icon="findings"
              title="No tested risks on this asset"
              description="Nothing has been confirmed here yet — that is the win state."
            />
          ) : (
            <RecordTable
              rows={findingRows}
              getRowKey={(finding) => finding.id}
              titleHeader="Risk"
              title={(finding) => finding.title}
              stripe={(finding) => finding.severity}
              subtitle={(finding) => (
                <ListMeta
                  items={[
                    compactFindingTag(finding.cveIds?.length ? finding.cveIds : [finding.cveId], 'CVE'),
                    <TimeAgo key="seen" date={finding.lastSeenAt} />,
                  ]}
                />
              )}
              rowActionLabel={(finding) => `Open risk: ${finding.title}`}
              onRowClick={(finding) => navigate(paths.findingDetail(finding.id))}
              columns={[
                {
                  key: 'status',
                  header: 'Status',
                  width: '150px',
                  render: (finding) => <FindingStatusBadge status={finding.state} />,
                  showOnMobile: true,
                },
                {
                  key: 'cvss',
                  header: 'CVSS',
                  width: '90px',
                  mono: true,
                  align: 'end',
                  render: (finding) => (
                    <span className={severityTone(finding.severity)}>
                      {finding.cvssScore != null ? finding.cvssScore.toFixed(1) : '—'}
                    </span>
                  ),
                },
              ]}
            />
          )
        ) : null}

        {activeTab === 'runs' ? (
          runRows.length === 0 ? (
            <ListEmptyState
              icon="runs"
              title="No assessments yet"
              description="Assessments run against this asset's scope will appear here."
            />
          ) : (
            <RecordTable
              rows={runRows}
              getRowKey={(run) => run.id}
              titleHeader="Assessment"
              title={(run) => run.title || 'Untitled assessment'}
              subtitle={(run) => run.goal}
              rowActionLabel={(run) => `Open assessment: ${run.title || 'Untitled'}`}
              onRowClick={(run) => navigate(paths.runDetail(run.id))}
              columns={[
                {
                  key: 'status',
                  header: 'Status',
                  width: '150px',
                  render: (run) => <RunStatusBadge status={run.status} />,
                  showOnMobile: true,
                },
                {
                  key: 'started',
                  header: 'Started',
                  width: '140px',
                  mono: true,
                  align: 'end',
                  render: (run) => <TimeAgo date={run.startedAt} />,
                },
              ]}
            />
          )
        ) : null}
      </div>
    </DetailPageShell>
  );
}
