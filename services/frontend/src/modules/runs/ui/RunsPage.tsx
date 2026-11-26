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
  RunStatusBadge,
} from '@null-ai/design-tokens/ui';
import { useRunsQuery } from '@/modules/security-ops/api';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';

type StatusFilter = 'all' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
type TriggerFilter = 'all' | 'manual' | 'scheduled' | 'event';

export default function RunsPage() {
  const navigate = useNavigate();
  const { activeScopeId } = useScope();
  const paths = useAppPaths();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [search, setSearch] = useState('');

  /* No refetchInterval override. A new or changed run now arrives as a live
     event (see `useLiveDataSync`), and the hook's own default already polls
     only while the cached list still shows active work — so an idle Runs page
     left open costs nothing, where the flat 5s override polled forever. */
  const { data: runs, isLoading } = useRunsQuery({ scopeId: activeScopeId });

  const rawRuns = useMemo(() => runs ?? [], [runs]);
  const countStatus = (status: string) => rawRuns.filter((run) => run.status === status).length;

  const filteredRuns = useMemo(() => rawRuns.filter((run) => {
    if (statusFilter !== 'all' && run.status !== statusFilter) return false;
    if (triggerFilter !== 'all' && run.trigger !== triggerFilter) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [run.title, run.goal, run.scopeName, run.displayId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  }), [rawRuns, search, statusFilter, triggerFilter]);

  const sortedRuns = [...filteredRuns].sort((a, b) => {
    const dateA = new Date(a.startedAt ?? a.queuedAt ?? a.createdAt ?? 0).getTime();
    const dateB = new Date(b.startedAt ?? b.queuedAt ?? b.createdAt ?? 0).getTime();
    return dateB - dateA;
  });

  const hasQuery = Boolean(search.trim()) || statusFilter !== 'all' || triggerFilter !== 'all';
  const clearQuery = () => {
    setSearch('');
    setStatusFilter('all');
    setTriggerFilter('all');
  };

  return (
    <ListPageShell title="Assessment History">
      {/* A run in flight is live, so Active takes the signal — the one place on
          this page the yellow is spent. */}
      <ListMetrics
        className="mb-8"
        label="Assessment throughput"
        items={[
          { label: 'Total assessments', value: rawRuns.length },
          { label: 'Active', value: countStatus('running'), severity: 'signal' },
          { label: 'Completed', value: countStatus('completed') },
          { label: 'Failed', value: countStatus('failed'), severity: 'critical' },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter assessments"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search assessments, goals, or scope"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by status"
              label="All statuses"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
              options={[
                { value: 'all', label: 'All statuses', count: rawRuns.length },
                { value: 'running', label: 'Running', count: countStatus('running'), swatchClass: 'bg-primary' },
                { value: 'queued', label: 'Queued', count: countStatus('queued') },
                { value: 'paused', label: 'Paused', count: countStatus('paused'), swatchClass: 'bg-warning' },
                { value: 'completed', label: 'Completed', count: countStatus('completed'), swatchClass: 'bg-success' },
                { value: 'failed', label: 'Failed', count: countStatus('failed'), swatchClass: 'bg-destructive' },
                { value: 'cancelled', label: 'Cancelled', count: countStatus('cancelled') },
              ]}
            />
            <FacetSelect
                aria-label="Filter by trigger"
                label="All triggers"
                value={triggerFilter}
                onChange={(value) => setTriggerFilter(value as TriggerFilter)}
                options={[
                  { value: 'all', label: 'All triggers' },
                  { value: 'manual', label: 'Manual' },
                  { value: 'scheduled', label: 'Scheduled' },
                  { value: 'event', label: 'Event' },
                ]}
              />
          </>
        }
      />

      {isLoading ? (
        <ListSkeleton label="Reading your assessments" />
      ) : sortedRuns.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No assessments match this query"
            description={`Your filters narrow ${rawRuns.length} assessments down to none.`}
            onClear={clearQuery}
          />
        ) : (
          <ListEmptyState
            icon="runs"
            title="No assessments in this scope"
            description="Nothing has run against this scope yet."
          />
        )
      ) : (
        // No left stripe: the severity stripe is a risk-only device. A run's
        // axis is status, which the pill column carries.
        <RecordTable
          rows={sortedRuns}
          getRowKey={(run) => run.id}
          titleHeader="Assessment"
          titleWidth="minmax(0,1.7fr)"
          title={(run) => run.title ?? 'Untitled assessment'}
          subtitle={(run) => run.goal ?? '—'}
          rowActionLabel={(run) => `Open assessment: ${run.title ?? 'Untitled assessment'}`}
          rowAttributes={(run) => ({ 'data-tour': `run-row-${run.id}` })}
          onRowClick={(run) => navigate(paths.runDetail(run.id))}
          columns={[
            {
              key: 'scope',
              header: 'Scope',
              width: 'minmax(0,0.9fr)',
              render: (run) => run.scopeName ?? 'Global',
              showOnMobile: true,
            },
            {
              key: 'status',
              header: 'Status',
              width: '140px',
              render: (run) => (
                <RunStatusBadge
                  status={run.status}
                  pauseReason={run.pauseReason}
                  interactionType={run.interactionType}
                />
              ),
              showOnMobile: true,
            },
            {
              key: 'findings',
              header: 'Risks',
              width: '80px',
              mono: true,
              align: 'end',
              render: (run) => ((run.findingsDiscovered ?? 0) > 0 ? run.findingsDiscovered : '—'),
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
