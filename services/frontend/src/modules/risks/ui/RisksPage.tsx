import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
} from "@null-ai/design-tokens/ui";
import { useLocal, type Finding, type RiskState } from "../../../local";
import { RISK_STATE_LABELS } from "../riskState";
type SeverityFilter = "all" | "critical" | "high" | "medium" | "low" | "info";
type StateFilter = "all" | RiskState;

const EMPTY_RISKS: Finding[] = [];

const STATE_TONE: Record<RiskState, StatusTone> = {
  potential: "warning",
  confirmed: "destructive",
  false_positive: "neutral",
  resolved: "success",
  accepted: "neutral",
};

export default function RisksPage() {
  const navigate = useNavigate();
  const { project, loading: isLoading } = useLocal();
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  const rows = project?.findings ?? EMPTY_RISKS;

  const countBySeverity = (value: string) =>
    rows.filter((row) => row.severity === value).length;
  const countByState = (value: RiskState) =>
    rows.filter((row) => row.state === value).length;

  const filtered = useMemo(
    () =>
      rows.filter((row) => {
        if (severityFilter !== "all" && row.severity !== severityFilter)
          return false;
        if (stateFilter !== "all" && row.state !== stateFilter) return false;
        if (!search.trim()) return true;

        const query = search.trim().toLowerCase();
        return [
          row.title,
          row.assetValue,
          row.location?.path,
          row.ruleId,
          row.source,
          ...row.cweIds,
          ...row.evidence.map((e) => e.title),
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(query));
      }),
    [rows, search, severityFilter, stateFilter],
  );

  const hasQuery =
    Boolean(search.trim()) || severityFilter !== "all" || stateFilter !== "all";
  const clearQuery = () => {
    setSearch("");
    setSeverityFilter("all");
    setStateFilter("all");
  };

  const openRisk = (row: Finding) =>
    navigate("/risks/" + encodeURIComponent(row.id));

  return (
    <ListPageShell title="Risks" data-tour="risks-page">
      {/* Posture across the whole scope, not the current filter. */}
      <ListMetrics
        className="mb-8"
        label="Risk severity"
        items={[
          {
            label: "Critical",
            value: countBySeverity("critical"),
            severity: "critical",
          },
          { label: "High", value: countBySeverity("high"), severity: "high" },
          {
            label: "Medium",
            value: countBySeverity("medium"),
            severity: "medium",
          },
          { label: "Low", value: countBySeverity("low"), severity: "low" },
        ]}
      />

      <QueryBar
        className="mb-8"
        aria-label="Filter risks"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search risks, assets, rules or files"
        facets={
          <>
            <FacetSelect
              aria-label="Filter by severity"
              label="All severities"
              value={severityFilter}
              onChange={(value) => setSeverityFilter(value as SeverityFilter)}
              options={[
                { value: "all", label: "All severities", count: rows.length },
                {
                  value: "critical",
                  label: "Critical",
                  count: countBySeverity("critical"),
                  swatchClass: "bg-critical",
                },
                {
                  value: "high",
                  label: "High",
                  count: countBySeverity("high"),
                  swatchClass: "bg-high",
                },
                {
                  value: "medium",
                  label: "Medium",
                  count: countBySeverity("medium"),
                  swatchClass: "bg-medium",
                },
                {
                  value: "low",
                  label: "Low",
                  count: countBySeverity("low"),
                  swatchClass: "bg-low",
                },
                {
                  value: "info",
                  label: "Info",
                  count: countBySeverity("info"),
                },
              ]}
            />
            <FacetSelect
              aria-label="Filter by state"
              label="All states"
              value={stateFilter}
              onChange={(value) => setStateFilter(value as StateFilter)}
              options={[
                { value: "all", label: "All states", count: rows.length },
                ...(Object.keys(RISK_STATE_LABELS) as RiskState[]).map(
                  (state) => ({
                    value: state,
                    label: RISK_STATE_LABELS[state],
                    count: countByState(state),
                  }),
                ),
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
            description={`${rows.length} imported ${rows.length === 1 ? "risk" : "risks"} in this scope.`}
            onClear={clearQuery}
          />
        ) : (
          <ListEmptyState
            icon="findings"
            title="No risks in this scope"
            description="Import analyzer results in the evidence library to see findings for this scope."
          />
        )
      ) : (
        <RecordTable
          rows={filtered}
          getRowKey={(row) => row.id}
          titleHeader="Risk"
          title={(row) => row.title}
          subtitle={(row) =>
            [row.source, row.ruleId].filter(Boolean).join(" · ")
          }
          stripe={(row) => row.severity}
          rowActionLabel={(row) => `Open risk: ${row.title}`}
          rowAttributes={(row) => ({ "data-tour": `risk-row-${row.id}` })}
          onRowClick={openRisk}
          columns={[
            {
              key: "asset",
              header: "Asset",
              render: (row) => row.assetValue || row.location?.path || "—",
              showOnMobile: true,
            },
            {
              key: "state",
              header: "State",
              width: "210px",
              render: (row) => (
                <span className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={STATE_TONE[row.state]}>
                    {RISK_STATE_LABELS[row.state]}
                  </StatusPill>
                </span>
              ),
              showOnMobile: true,
            },
            {
              key: "cvss",
              header: "CVSS",
              width: "90px",
              mono: true,
              align: "end",
              render: (row) => (
                <span className={severityTone(row.severity)}>
                  {row.cvssScore != null ? row.cvssScore.toFixed(1) : "—"}
                </span>
              ),
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
