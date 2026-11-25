import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Button,
  FacetSelect,
  ListEmptyState,
  ListMetrics,
  ListPageShell,
  QueryBar,
  RecordTable,
} from "@null-ai/design-tokens/ui";
import { useLocal, type Scope } from "../../../local";

const filters = [
  { value: "all", label: "All assessments", matches: (_scope: Scope) => true },
  {
    value: "empty",
    label: "Awaiting evidence",
    matches: (scope: Scope) => scope.artifactCount === 0,
  },
  {
    value: "risks",
    label: "With risks",
    matches: (scope: Scope) => scope.findingCount > 0,
  },
  {
    value: "reviewed",
    label: "With saved reviews",
    matches: (scope: Scope) => scope.reviewCount > 0,
  },
];

export default function RunsPage() {
  const { scopes, select } = useLocal();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const query = search.trim().toLowerCase();
  const facet = filters.find((item) => item.value === filter) ?? filters[0];
  const sortedRuns = scopes
    .filter(
      (scope) =>
        facet.matches(scope) &&
        [scope.name, scope.scope, scope.id].some((value) =>
          value.toLowerCase().includes(query),
        ),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const hasQuery = Boolean(query) || filter !== "all";

  return (
    <ListPageShell
      title="Assessment History"
      subtitle="Each local scope has an assessment record for its evidence, risks and reviews."
      actions={
        <Button asChild>
          <Link to="/scopes">Manage scopes</Link>
        </Button>
      }
    >
      <ListMetrics
        className="mb-8"
        label="Assessment records"
        items={[
          { label: "Total assessments", value: scopes.length },
          {
            label: "Evidence files",
            value: scopes.reduce(
              (count, scope) => count + scope.artifactCount,
              0,
            ),
          },
          {
            label: "Imported risks",
            value: scopes.reduce(
              (count, scope) => count + scope.findingCount,
              0,
            ),
          },
          {
            label: "Saved reviews",
            value: scopes.reduce(
              (count, scope) => count + scope.reviewCount,
              0,
            ),
          },
        ]}
      />
      <QueryBar
        className="mb-8"
        aria-label="Filter assessments"
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search assessments or scope"
        facets={
          <FacetSelect
            aria-label="Filter assessment records"
            label="All assessments"
            value={filter}
            onChange={setFilter}
            options={filters.map(({ value, label, matches }) => ({
              value,
              label,
              count: scopes.filter(matches).length,
            }))}
          />
        }
      />
      {sortedRuns.length === 0 ? (
        hasQuery ? (
          <ListEmptyState
            variant="filtered"
            icon="search"
            title="No assessments match this query"
            description="Try a different scope name or clear your filters."
            onClear={() => {
              setSearch("");
              setFilter("all");
            }}
          />
        ) : (
          <ListEmptyState
            icon="runs"
            title="No assessments yet"
            description="Create a scope to start collecting evidence for an assessment."
          />
        )
      ) : (
        <RecordTable
          rows={sortedRuns}
          getRowKey={(run) => run.id}
          titleHeader="Assessment"
          titleWidth="minmax(0,1.7fr)"
          title={(run) => run.name}
          subtitle={(run) => run.scope}
          rowActionLabel={(run) => `Open assessment: ${run.name}`}
          rowAttributes={(run) => ({ "data-tour": `run-row-${run.id}` })}
          onRowClick={(run) => {
            select(run.id);
            navigate("/runs/" + encodeURIComponent(run.id));
          }}
          columns={[
            {
              key: "updated",
              header: "Updated",
              render: (run) => new Date(run.updatedAt).toLocaleDateString(),
              showOnMobile: true,
            },
            {
              key: "evidence",
              header: "Evidence files",
              mono: true,
              align: "end",
              render: (run) => run.artifactCount,
            },
            {
              key: "risks",
              header: "Risks",
              mono: true,
              align: "end",
              render: (run) => run.findingCount,
            },
            {
              key: "reviews",
              header: "Reviews",
              mono: true,
              align: "end",
              render: (run) => run.reviewCount,
            },
          ]}
        />
      )}
    </ListPageShell>
  );
}
