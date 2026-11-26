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
  SeverityBadge,
} from '@null-ai/design-tokens/ui';
import { useAssetsQuery } from '@/modules/security-ops/api';
import { useAppPaths } from '@shared/contexts/AppPathContext';
import { useScope } from '@shared/contexts/ScopeContext';
import type { Asset, AssetFocusLabel } from '@/modules/security-ops/types';
import { AssetKindBadge } from './components/AssetKindBadge';


const focusRank = (label?: string | null): number => {
  switch (label) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
};


const sortAssetsByFocus = (left: Asset, right: Asset): number => {
  const focusDelta = (right.focus?.score ?? 0) - (left.focus?.score ?? 0);
  if (focusDelta !== 0) return focusDelta;
  const focusRankDelta = focusRank(right.focus?.label) - focusRank(left.focus?.label);
  if (focusRankDelta !== 0) return focusRankDelta;
  const dateA = left.firstSeenAt ? new Date(left.firstSeenAt).getTime() : 0;
  const dateB = right.firstSeenAt ? new Date(right.firstSeenAt).getTime() : 0;
  return dateB - dateA;
};

// What we know about an asset beyond its name — the row's quiet second line.
const assetContextLine = (asset: Asset): string => {
  const facts: string[] = [];
  if (asset.tags.length > 0) facts.push(asset.tags.join(', '));

  return facts.length > 0 ? facts.join(' · ') : 'Live surface';
};


export default function AssetsPage() {
  const navigate = useNavigate();
  const { activeScopeId } = useScope();
  const paths = useAppPaths();
  const [kindFilter, setKindFilter] = useState<'all' | 'domain' | 'ip' | 'cloud_resource'>('all');
  const [focusFilter, setFocusFilter] = useState<'all' | AssetFocusLabel>('all');
  const [search, setSearch] = useState('');

  const { data: assets, isLoading } = useAssetsQuery({ scopeId: activeScopeId });


  const rawAssets = useMemo(() => assets ?? [], [assets]);



  const filteredAssets = useMemo(() => rawAssets.filter((asset) => {
    if (kindFilter !== 'all' && asset.kind !== kindFilter) return false;
    if (focusFilter !== 'all' && (asset.focus?.label ?? 'low') !== focusFilter) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [asset.value, ...(asset.tags ?? [])].some((value) => value.toLowerCase().includes(query));
  }), [focusFilter, kindFilter, rawAssets, search]);

  const sortedAssets = [...filteredAssets].sort(sortAssetsByFocus);

  const countKind = (kind: string) => rawAssets.filter((asset) => asset.kind === kind).length;
  const countFocus = (label: string) => rawAssets.filter((asset) => (asset.focus?.label ?? 'low') === label).length;

  const hasQuery = Boolean(search.trim()) || kindFilter !== 'all' || focusFilter !== 'all';
  const clearQuery = () => {
    setSearch('');
    setKindFilter('all');
    setFocusFilter('all');
  };






  return (
    <ListPageShell title="Asset Intelligence" data-tour="assets-page">
      <ListMetrics
        className="mb-8"
        label="Surface posture"
        items={[
          { label: 'Surfaces', value: rawAssets.length },
          { label: 'Critical focus', value: countFocus('critical'), severity: 'critical' },
        ]}
      />


      <QueryBar
        className="mb-8"
        aria-label="Filter assets"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search values or tags"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by type"
              label="All types"
              value={kindFilter}
              onChange={(value) => setKindFilter(value as typeof kindFilter)}
              options={[
                { value: 'all', label: 'All types', count: rawAssets.length },
                { value: 'domain', label: 'Domains', count: countKind('domain') },
                { value: 'ip', label: 'IP addresses', count: countKind('ip') },
                { value: 'cloud_resource', label: 'Cloud resources', count: countKind('cloud_resource') },
              ]}
            />
            <FacetSelect
              aria-label="Filter by focus"
              label="All focus"
              value={focusFilter}
              onChange={(value) => setFocusFilter(value as typeof focusFilter)}
              options={[
                { value: 'all', label: 'All focus', count: rawAssets.length },
                { value: 'critical', label: 'Critical', count: countFocus('critical'), swatchClass: 'bg-critical' },
                { value: 'high', label: 'High', count: countFocus('high'), swatchClass: 'bg-high' },
                { value: 'medium', label: 'Medium', count: countFocus('medium'), swatchClass: 'bg-medium' },
                { value: 'low', label: 'Low', count: countFocus('low'), swatchClass: 'bg-low' },
              ]}
            />
          </>
        }
      />

      {isLoading ? (
        <ListSkeleton label="Mapping your surface" />
      ) : sortedAssets.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No assets match this query"
            description={`Your filters narrow ${rawAssets.length} assets down to none.`}
            onClear={clearQuery}
          />
        ) : (
          <ListEmptyState
            icon="assets"
            title="No assets in this scope"
            description="Nothing has been discovered on this scope's surface yet."
          />
        )
      ) : (
        <RecordTable
          rows={sortedAssets}
          getRowKey={(asset) => asset.id}
          titleHeader="Asset"
          title={(asset) => asset.value}
          subtitle={assetContextLine}
          stripe={(asset) => asset.focus?.label}
          rowActionLabel={(asset) => `Open asset: ${asset.value}`}
          onRowClick={(asset) => navigate(paths.assetDetail(asset.id))}
          columns={[
            {
              key: 'kind',
              header: 'Type',
              width: '140px',
              render: (asset) => <AssetKindBadge kind={asset.kind} />,
              showOnMobile: true,
            },
            {
              key: 'focus',
              header: 'Focus',
              width: '150px',
              render: (asset) => <SeverityBadge severity={asset.focus?.label ?? 'low'} />,
              showOnMobile: true,
            },
            {
              key: 'first-seen',
              header: 'First seen',
              width: '110px',
              mono: true,
              align: 'end',
              render: (asset) =>
                asset.firstSeenAt ? new Date(asset.firstSeenAt).toLocaleDateString() : '—',
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
