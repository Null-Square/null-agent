import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FacetSelect,
  ListEmptyState,
  ListMetrics,
  ListPageShell,
  QueryBar,
  RecordTable,
  SeverityBadge,
} from "@null-ai/design-tokens/ui";
import { useLocal } from "../../../local";
import {
  assetPath,
  recordedAssets,
  type Asset,
  type AssetFocusLabel,
} from "../recordedAssets";
import { AssetKindBadge } from "./components/AssetKindBadge";

const assetContextLine = (asset: Asset) => {
  const count = asset.findings.length;
  return `${count} imported ${count === 1 ? "finding" : "findings"}`;
};

export default function AssetsPage() {
  const navigate = useNavigate();
  const { project } = useLocal();
  const [kindFilter, setKindFilter] = useState("all");
  const [focusFilter, setFocusFilter] = useState<"all" | AssetFocusLabel>(
    "all",
  );
  const [search, setSearch] = useState("");

  const rawAssets = useMemo(() => recordedAssets(project), [project]);
  const kinds = [...new Set(rawAssets.map((asset) => asset.kind))].sort();

  const filteredAssets = useMemo(
    () =>
      rawAssets.filter((asset) => {
        if (kindFilter !== "all" && "kind:" + asset.kind !== kindFilter)
          return false;
        if (focusFilter !== "all" && asset.focus !== focusFilter) return false;
        if (!search.trim()) return true;
        const query = search.trim().toLowerCase();
        return [asset.value, asset.kind].some((value) =>
          value.toLowerCase().includes(query),
        );
      }),
    [focusFilter, kindFilter, rawAssets, search],
  );

  const countKind = (kind: string) =>
    rawAssets.filter((asset) => asset.kind === kind).length;
  const countFocus = (label: string) =>
    rawAssets.filter((asset) => asset.focus === label).length;

  const hasQuery =
    Boolean(search.trim()) || kindFilter !== "all" || focusFilter !== "all";
  const clearQuery = () => {
    setSearch("");
    setKindFilter("all");
    setFocusFilter("all");
  };

  return (
    <ListPageShell title="Asset Intelligence" data-tour="assets-page">
      <ListMetrics
        className="mb-8"
        label="Recorded assets"
        items={[
          { label: "Surfaces", value: rawAssets.length },
          {
            label: "Critical focus",
            value: countFocus("critical"),
            severity: "critical",
          },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter assets"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search assets"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by type"
              label="All types"
              value={kindFilter}
              onChange={setKindFilter}
              options={[
                { value: "all", label: "All types", count: rawAssets.length },
                ...kinds.map((kind) => ({
                  value: "kind:" + kind,
                  label:
                    kind === "unknown"
                      ? "Unspecified"
                      : kind.replaceAll("_", " "),
                  count: countKind(kind),
                })),
              ]}
            />
            <FacetSelect
              aria-label="Filter by focus"
              label="All focus"
              value={focusFilter}
              onChange={(value) => setFocusFilter(value as typeof focusFilter)}
              options={[
                { value: "all", label: "All focus", count: rawAssets.length },
                {
                  value: "critical",
                  label: "Critical",
                  count: countFocus("critical"),
                  swatchClass: "bg-critical",
                },
                {
                  value: "high",
                  label: "High",
                  count: countFocus("high"),
                  swatchClass: "bg-high",
                },
                {
                  value: "medium",
                  label: "Medium",
                  count: countFocus("medium"),
                  swatchClass: "bg-medium",
                },
                {
                  value: "low",
                  label: "Low",
                  count: countFocus("low"),
                  swatchClass: "bg-low",
                },
              ]}
            />
          </>
        }
      />

      {filteredAssets.length === 0 ? (
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
            description="Upload findings with asset values to populate this scope."
          />
        )
      ) : (
        <RecordTable
          rows={filteredAssets}
          getRowKey={(asset) => asset.value}
          titleHeader="Asset"
          title={(asset) => asset.value}
          subtitle={assetContextLine}
          stripe={(asset) => asset.focus}
          rowActionLabel={(asset) => `Open asset: ${asset.value}`}
          onRowClick={(asset) => navigate(assetPath(asset.value))}
          columns={[
            {
              key: "kind",
              header: "Type",
              width: "140px",
              render: (asset) => <AssetKindBadge kind={asset.kind} />,
              showOnMobile: true,
            },
            {
              key: "focus",
              header: "Focus",
              width: "150px",
              render: (asset) => <SeverityBadge severity={asset.focus} />,
              showOnMobile: true,
            },
            {
              key: "first-seen",
              header: "First imported",
              width: "110px",
              mono: true,
              align: "end",
              render: (asset) =>
                asset.firstImportedAt
                  ? new Date(asset.firstImportedAt).toLocaleDateString()
                  : "—",
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
