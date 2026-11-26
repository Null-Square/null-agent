import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  FacetSelect,
  ListEmptyState,
  ListMetrics,
  QueryBar,
  RecordTable,
  StatusPill,
} from '@null-ai/design-tokens/ui';
import SettingsLayout from '@/modules/settings/ui/SettingsLayout';
import { useScopesQuery } from '@/modules/security-ops/api';
import { TimeAgo } from '@shared/ui/TimeAgo';
import CreateScopeModal from './components/CreateScopeModal';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useOrgPermissions } from '@modules/permissions';

type TargetState = 'verified' | 'pending' | 'missing';
type StateFilter = 'all' | TargetState;
type ModeFilter = 'all' | 'whitebox' | 'blackbox';

const TARGET_STATE: Record<TargetState, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Pending', tone: 'warning' },
  missing: { label: 'Missing', tone: 'warning' },
};

const targetState = (scope: { targetCount?: number | null; verifiedTargetCount?: number | null }): TargetState => {
  if ((scope.verifiedTargetCount ?? 0) > 0) return 'verified';
  return (scope.targetCount ?? 0) > 0 ? 'pending' : 'missing';
};

/**
 * ScopesPage — the scopes list: target verification, execution mode, coverage.
 */
export default function ScopesPage() {
  const navigate = useNavigate();
  const paths = useAppPaths();
  const { data: scopes } = useScopesQuery();
  const canCreateScope = useOrgPermissions().has('org.scope.write');
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');

  const rawScopes = useMemo(() => scopes ?? [], [scopes]);
  const countState = (state: TargetState) => rawScopes.filter((scope) => targetState(scope) === state).length;

  const filtered = useMemo(() => rawScopes.filter((scope) => {
    if (stateFilter !== 'all' && targetState(scope) !== stateFilter) return false;
    if (modeFilter === 'whitebox' && scope.whiteboxEnabled !== true) return false;
    if (modeFilter === 'blackbox' && scope.whiteboxEnabled === true) return false;
    if (!search.trim()) return true;
    return scope.name.toLowerCase().includes(search.trim().toLowerCase());
  }), [modeFilter, rawScopes, search, stateFilter]);

  const hasQuery = Boolean(search.trim()) || stateFilter !== 'all' || modeFilter !== 'all';

  return (
    <SettingsLayout
      title="Scopes"
      description="Review target verification, execution mode, and coverage across your scopes."
      actions={
        canCreateScope ? (
          <Button
            onClick={() => {
              setShowCreate(true);
            }}
          >
            New scope
          </Button>
        ) : null
      }
    >
      <ListMetrics
        className="mb-8"
        label="Scope coverage"
        items={[
          { label: 'Scopes', value: rawScopes.length },
          { label: 'Verified targets', value: countState('verified') },
          { label: 'Missing targets', value: countState('missing'), severity: 'high' },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter scopes"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search scopes"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by target state"
              label="All states"
              value={stateFilter}
              onChange={(value) => setStateFilter(value as StateFilter)}
              options={[
                { value: 'all', label: 'All states', count: rawScopes.length },
                { value: 'verified', label: 'Verified', count: countState('verified'), swatchClass: 'bg-success' },
                { value: 'pending', label: 'Pending', count: countState('pending'), swatchClass: 'bg-warning' },
                { value: 'missing', label: 'Missing', count: countState('missing'), swatchClass: 'bg-warning' },
              ]}
            />
            <FacetSelect
              aria-label="Filter by mode"
              label="All modes"
              value={modeFilter}
              onChange={(value) => setModeFilter(value as ModeFilter)}
              options={[
                { value: 'all', label: 'All modes', count: rawScopes.length },
                { value: 'whitebox', label: 'Whitebox', count: rawScopes.filter((s) => s.whiteboxEnabled === true).length },
                { value: 'blackbox', label: 'Blackbox', count: rawScopes.filter((s) => s.whiteboxEnabled !== true).length },
              ]}
            />
          </>
        }
      />

      {filtered.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No scopes match this query"
            description={`Your filters narrow ${rawScopes.length} scopes down to none.`}
            onClear={() => {
              setSearch('');
              setStateFilter('all');
              setModeFilter('all');
            }}
          />
        ) : (
          <ListEmptyState icon="scope" title="No scopes yet" description="A scope is the authorisation boundary an assessment runs inside." />
        )
      ) : (
        <RecordTable
          rows={filtered}
          getRowKey={(scope) => scope.id}
          titleHeader="Scope"
          title={(scope) => scope.name}
          subtitle={(scope) => (scope.whiteboxEnabled === true ? 'Whitebox' : 'Blackbox')}
          rowActionLabel={(scope) => `Open scope: ${scope.name}`}
          onRowClick={(scope) => navigate(paths.scopeDetail(scope.id))}
          columns={[
            {
              key: 'execution',
              header: 'Execution',
              render: (scope) => (scope.attachedRunner ? `this computer + ${scope.attachedRunner.name}` : 'this computer'),
              showOnMobile: true,
            },
            {
              key: 'state',
              header: 'Targets',
              width: '150px',
              render: (scope) => {
                const state = TARGET_STATE[targetState(scope)];
                return <StatusPill tone={state.tone}>{state.label}</StatusPill>;
              },
              showOnMobile: true,
            },
            {
              key: 'last-run',
              header: 'Last run',
              width: '140px',
              mono: true,
              align: 'end',
              render: (scope) => <TimeAgo date={scope.lastRunAt ?? null} />,
            },
          ]}
        />
      )}

      <CreateScopeModal open={showCreate} onClose={() => setShowCreate(false)} />
    </SettingsLayout>
  );
}
