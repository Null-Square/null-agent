import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FacetSelect,
  ListEmptyState,
  ListMetrics,
  ListPageShell,
  ListSkeleton,
  QueryBar,
  RecordTable,
  StatusPill,
  type StatusTone,
  severityTone,
  KevBadge,
  MatchCaveatBadge,
} from '@null-ai/design-tokens/ui';
import { useRisksQuery } from '@/modules/security-ops/api';
import { RISK_STATE_LABELS } from '@/modules/risks/riskState';
import type { RiskListItem, RiskState } from '@/modules/security-ops/types';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';
type StateFilter = 'all' | RiskState;

const EMPTY_RISKS: RiskListItem[] = [];

// The score is the severity, so it is graded by the same ramp.
// A lifecycle state is a word graded by colour. `verifying` is the only live
// one, and the only thing that blinks.
const STATE_TONE: Record<RiskState, StatusTone> = {
  potential: 'warning',
  verifying: 'signal',
  confirmed: 'destructive',
  not_reproduced: 'success',
  dismissed: 'neutral',
  resolved: 'success',
  accepted: 'neutral',
};

export default function RisksPage() {
  const navigate = useNavigate();
  const { activeScopeId } = useScope();
  const paths = useAppPaths();
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');

  const { data: risks, isLoading } = useRisksQuery(activeScopeId);
  const rows = risks ?? EMPTY_RISKS;

  const countBySeverity = (value: string) => rows.filter((row) => row.severity === value).length;
  const countByState = (value: RiskState) => rows.filter((row) => row.state === value).length;

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (severityFilter !== 'all' && row.severity !== severityFilter) return false;
        if (stateFilter !== 'all' && row.state !== stateFilter) return false;
        if (!search.trim()) return true;

        const query = search.trim().toLowerCase();
        return [row.title, row.assetValue, row.subtitle]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      }),
    [rows, search, severityFilter, stateFilter],
  );

  const hasQuery = Boolean(search.trim()) || severityFilter !== 'all' || stateFilter !== 'all';
  const clearQuery = () => {
    setSearch('');
    setSeverityFilter('all');
    setStateFilter('all');
  };

  // A confirmed exposure is a Risk and has a canonical record, so it opens the
  // one detail shell. An unconfirmed one is still a verification workflow —
  // there is nothing canonical to show yet — so it keeps the advisory route.
  const openRisk = (row: RiskListItem) => {
    const isUnverifiedExposure = row.recordKind === 'exposure' && row.state !== 'confirmed';
    navigate(isUnverifiedExposure ? paths.exposureDetail(row.id) : paths.findingDetail(row.id));
  };

  return (
    <ListPageShell title="Risks" data-tour="risks-page">
      {/* Posture across the whole scope, not the current filter. */}
      <ListMetrics
        className="mb-8"
        label="Risk severity"
        items={[
          { label: 'Critical', value: countBySeverity('critical'), severity: 'critical' },
          { label: 'High', value: countBySeverity('high'), severity: 'high' },
          { label: 'Medium', value: countBySeverity('medium'), severity: 'medium' },
          { label: 'Low', value: countBySeverity('low'), severity: 'low' },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter risks"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search risks, assets, CVEs"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by severity"
              label="All severities"
              value={severityFilter}
              onChange={(value) => setSeverityFilter(value as SeverityFilter)}
              options={[
                { value: 'all', label: 'All severities', count: rows.length },
                { value: 'critical', label: 'Critical', count: countBySeverity('critical'), swatchClass: 'bg-critical' },
                { value: 'high', label: 'High', count: countBySeverity('high'), swatchClass: 'bg-high' },
                { value: 'medium', label: 'Medium', count: countBySeverity('medium'), swatchClass: 'bg-medium' },
                { value: 'low', label: 'Low', count: countBySeverity('low'), swatchClass: 'bg-low' },
              ]}
            />
            <FacetSelect
              aria-label="Filter by state"
              label="All states"
              value={stateFilter}
              onChange={(value) => setStateFilter(value as StateFilter)}
              options={[
                { value: 'all', label: 'All states', count: rows.length },
                ...(Object.keys(RISK_STATE_LABELS) as RiskState[]).map((state) => ({
                  value: state,
                  label: RISK_STATE_LABELS[state],
                  count: countByState(state),
                })),
              ]}
            />
          </>
        }
      />

      {isLoading ? (
        <ListSkeleton label="Reading your risks" />
      ) : filtered.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No risks match this query"
            description={`Your filters narrow ${rows.length} risks down to none.`}
            onClear={clearQuery}
          />
        ) : (
          <ListEmptyState
            icon="findings"
            title="No risks in this scope"
            description="Nothing has been found against this scope yet — that is the win state."
          />
        )
      ) : (
        <RecordTable
          rows={filtered}
          getRowKey={(row) => row.key}
          titleHeader="Risk"
          title={(row) => row.title}
          subtitle={(row) => row.subtitle}
          stripe={(row) => row.severity}
          rowActionLabel={(row) => `Open risk: ${row.title}`}
          rowAttributes={(row) => ({ 'data-tour': `risk-row-${row.id}` })}
          onRowClick={openRisk}
          columns={[
            {
              key: 'asset',
              header: 'Asset',
              render: (row) => row.assetValue ?? 'Global',
              showOnMobile: true,
            },
            {
              key: 'state',
              header: 'State',
              width: '210px',
              render: (row) => (
                <span className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={STATE_TONE[row.state]}>{RISK_STATE_LABELS[row.state]}</StatusPill>
                  {row.kevListed ? <KevBadge /> : null}
                  {row.backportRisk ? <MatchCaveatBadge kind="backport" /> : null}
                  {row.versionConflict ? <MatchCaveatBadge kind="conflict" /> : null}
                </span>
              ),
              showOnMobile: true,
            },
            {
              key: 'cvss',
              header: 'CVSS',
              width: '90px',
              mono: true,
              align: 'end',
              render: (row) => (
                <span className={severityTone(row.severity)}>
                  {row.cvssScore != null ? row.cvssScore.toFixed(1) : '—'}
                </span>
              ),
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
