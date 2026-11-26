import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  FacetSelect,
  ListEmptyState,
  ListMetrics,
  ListPageShell,
  ListSkeleton,
  QueryBar,
  RecordTable,
} from '@null-ai/design-tokens/ui';
import { useAuth } from '@/modules/auth';
import { useOrganizationMembersQuery, useRunnersQuery } from '@/modules/security-ops/api';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { RunnerStatusBadge } from './components/RunnerStatusBadge';
import DeployRunnerModal from './components/DeployRunnerModal';
import { TimeAgo } from '@shared/ui/TimeAgo';

type StatusFilter = 'all' | 'active' | 'offline';

const isActive = (status: string | null | undefined) => status === 'online' || status === 'busy';

export default function RunnersPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { data: runners, isLoading } = useRunnersQuery();
  const { data: members } = useOrganizationMembersQuery({ enabled: true });
  const { user } = useAuth();

  const currentMember = members?.find((m) => m.userId === user?.id);
  const isAdmin = currentMember?.role === 'admin';

  const [showDeploy, setShowDeploy] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const privateRunners = useMemo(
    () => (runners ?? []).filter((runner) => runner.type === 'private'),
    [runners],
  );

  const activeCount = privateRunners.filter((runner) => isActive(runner.status)).length;
  const offlineCount = privateRunners.length - activeCount;
  const assignedScopes = privateRunners.reduce((total, runner) => total + (runner.assignedScopes ?? []).length, 0);

  const filtered = useMemo(() => privateRunners.filter((runner) => {
    if (statusFilter === 'active' && !isActive(runner.status)) return false;
    if (statusFilter === 'offline' && isActive(runner.status)) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [runner.name, runner.platform].filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
  }), [privateRunners, search, statusFilter]);

  const deployRunner = () => {
    setShowDeploy(true);
  };

  const hasQuery = Boolean(search.trim()) || statusFilter !== 'all';

  return (
    <ListPageShell
      title="Private fleet"
      subtitle="Runners that execute security operations inside your own network. This computer is the fallback."
      actions={isAdmin ? <Button onClick={deployRunner}>Deploy runner</Button> : null}
    >
      <ListMetrics
        className="mb-8"
        label="Fleet status"
        items={[
          { label: 'Total nodes', value: privateRunners.length },
          { label: 'Active', value: activeCount, severity: 'signal' },
          { label: 'Offline', value: offlineCount, severity: 'high' },
          { label: 'Scopes assigned', value: assignedScopes },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter runners"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search runners or platforms"
        facets={
          <FacetSelect
            aria-label="Filter by status"
            label="All statuses"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as StatusFilter)}
            options={[
              { value: 'all', label: 'All statuses', count: privateRunners.length },
              { value: 'active', label: 'Active', count: activeCount, swatchClass: 'bg-primary' },
              { value: 'offline', label: 'Offline', count: offlineCount },
            ]}
          />
        }
      />

      {isLoading ? (
        <ListSkeleton label="Reaching your fleet" />
      ) : filtered.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No runners match this query"
            description={`Your filters narrow ${privateRunners.length} runners down to none.`}
            onClear={() => {
              setSearch('');
              setStatusFilter('all');
            }}
          />
        ) : (
          <ListEmptyState
            icon="runner"
            title="No private nodes enrolled"
            description="Deploy a private runner to execute security operations inside your own network. This computer is used until then."
            action={isAdmin ? <Button onClick={deployRunner}>Connect first node</Button> : undefined}
          />
        )
      ) : (
        <RecordTable
          rows={filtered}
          getRowKey={(runner) => runner.id}
          titleHeader="Runner"
          title={(runner) => runner.name}
          subtitle={(runner) =>
            `${runner.platform ?? 'Unknown platform'} · ${(runner.assignedScopes ?? []).length} scopes assigned`
          }
          rowActionLabel={(runner) => `Open runner: ${runner.name}`}
          onRowClick={(runner) => navigate(paths.runnerDetail(runner.id))}
          columns={[
            {
              key: 'status',
              header: 'Status',
              width: '170px',
              render: (runner) => (
                <RunnerStatusBadge status={runner.status} healthState={runner.metadata?.healthState} />
              ),
              showOnMobile: true,
            },
            {
              key: 'heartbeat',
              header: 'Heartbeat',
              width: '150px',
              mono: true,
              align: 'end',
              render: (runner) => <TimeAgo date={runner.lastHeartbeatAt} />,
            },
          ]}
        />
      )}

      <DeployRunnerModal open={showDeploy} onClose={() => setShowDeploy(false)} />
    </ListPageShell>
  );
}
