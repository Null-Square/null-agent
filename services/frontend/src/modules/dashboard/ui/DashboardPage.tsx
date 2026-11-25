import { Link } from "react-router-dom";
import {
  Button,
  CellIcon,
  ChartBand,
  ChartFrame,
  cn,
  DonutChart,
  ListEmptyState,
  ListMetrics,
  ListPageShell,
  RecordTable,
  severityTone,
  Sparkline,
} from "@null-ai/design-tokens/ui";
import { useLocal, useReadiness, type Finding } from "../../../local";
import { assetPath, recordedAssets } from "../../assets/recordedAssets";
import { isOpenRisk } from "../../risks/riskState";

const severityData = [
  { label: "Critical", key: "critical", color: "var(--ns-critical)" },
  { label: "High", key: "high", color: "var(--ns-high)" },
  { label: "Medium", key: "medium", color: "var(--ns-medium)" },
  { label: "Low", key: "low", color: "var(--ns-low)" },
  { label: "Info", key: "info", color: "var(--ns-info)" },
  { label: "Unrated", key: "unknown", color: "var(--color-muted-foreground)" },
] as const;

function severityRank(finding: Finding) {
  const index = severityData.findIndex(({ key }) => finding.severity === key);
  return index < 0 ? severityData.length - 1 : index;
}

function riskTrajectory(findings: Finding[]) {
  const deltas = new Map<string, number>();
  for (const finding of findings) {
    for (const event of finding.history) {
      const day = event.createdAt.slice(0, 10);
      const delta =
        Number(isOpenRisk(event.toStatus)) - Number(isOpenRisk(event.fromStatus));
      deltas.set(day, (deltas.get(day) ?? 0) + delta);
    }
  }
  if (!deltas.size) return [];
  const now = new Date();
  const first = new Date(now);
  first.setUTCDate(now.getUTCDate() - 29);
  const cutoff = first.toISOString().slice(0, 10);
  let open = [...deltas].reduce(
    (total, [day, delta]) => (day < cutoff ? total + delta : total),
    0,
  );
  return Array.from({ length: 30 }, (_, offset) => {
    const date = new Date(first);
    date.setUTCDate(first.getUTCDate() + offset);
    const day = date.toISOString().slice(0, 10);
    open += deltas.get(day) ?? 0;
    return { day, open };
  });
}

const quietLink =
  "text-sm text-muted-foreground transition-colors hover:text-foreground";

export default function DashboardPage() {
  const { project, scopes } = useLocal();
  const readiness = useReadiness();
  const findings = project?.findings ?? [];
  const open = findings.filter((finding) => isOpenRisk(finding.state));
  const trend = riskTrajectory(findings);
  const topRisks = [...open]
    .sort(
      (a, b) =>
        (b.cvssScore ?? -1) - (a.cvssScore ?? -1) ||
        severityRank(a) - severityRank(b),
    )
    .slice(0, 5);
  const assets = recordedAssets(project);
  const recent = [...scopes]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const segments = severityData.map(({ label, key, color }) => ({
    label,
    color,
    value: open.filter((finding) => finding.severity === key).length,
  }));

  return (
    <ListPageShell
      data-tour="dashboard-page"
      title={
        <span className="flex items-center gap-5">
          <CellIcon name="dashboard" size={34} className="text-foreground/70" />
          Dashboard
        </span>
      }
      subtitle={project ? project.name : "Local workspace"}
    >
      {!project ? (
        <ListEmptyState
          icon="scope"
          title="Create your first scope"
          description="Give your assessment a name to start collecting evidence and findings."
          action={
            <Button asChild>
              <Link to="/scopes">Manage scopes</Link>
            </Button>
          }
        />
      ) : (
        <>
          <ListMetrics
            label="Scope at a glance"
            className="mb-14"
            items={[
              { label: "Open risks", value: open.length },
              {
                label: "Critical & high",
                value: open.filter((finding) => severityRank(finding) < 2)
                  .length,
                severity: "critical",
              },
              { label: "Recorded assets", value: assets.length },
              { label: "Evidence files", value: project.artifactCount },
            ]}
          />
          <div className="flex flex-col gap-16">
            <ChartBand first>
              <ChartFrame
                span={12}
                icon="activity"
                title="Vulnerability trajectory"
                caption="Open findings from retained history over the last 30 days (UTC)"
              >
                <Sparkline
                  labels={trend.map((point) => point.day.slice(5))}
                  height={220}
                  showAxis
                  showLegend
                  emptyIcon="activity"
                  emptyLabel="No retained finding history yet"
                  series={[
                    {
                      key: "open",
                      label: "Open risks",
                      lead: true,
                      color: "var(--ns-critical)",
                      values: trend.map((point) => point.open),
                    },
                  ]}
                />
              </ChartFrame>
            </ChartBand>
            <ChartBand>
              <ChartFrame
                span={7}
                icon="findings"
                title="Top risks"
                caption="Open imported findings, ordered by available CVSS"
                action={
                  <Link className={quietLink} to="/risks">
                    View risks
                  </Link>
                }
              >
                <div className="flex-1 divide-y divide-border">
                  {topRisks.map((risk) => (
                    <Link
                      key={risk.id}
                      to={"/risks/" + encodeURIComponent(risk.id)}
                      className="group flex w-full items-center gap-4 py-3.5 text-left transition-colors hover:bg-foreground/[0.03]"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "h-9 w-[3px] flex-none",
                          severityTone(risk.severity, "bg"),
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-foreground">
                          {risk.title}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {risk.assetValue ?? risk.location?.path}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "flex-none font-mono text-base font-bold tabular-nums",
                          severityTone(risk.severity),
                        )}
                      >
                        {risk.cvssScore == null
                          ? "—"
                          : risk.cvssScore.toFixed(1)}
                      </span>
                    </Link>
                  ))}
                  {!topRisks.length && (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      No open findings in this scope
                    </p>
                  )}
                </div>
              </ChartFrame>
              <ChartFrame
                span={5}
                icon="assets"
                title="Asset findings"
                caption="Retained findings by recorded asset"
                action={
                  <Link className={quietLink} to="/assets">
                    View assets
                  </Link>
                }
              >
                <RecordTable
                  rows={assets.slice(0, 5)}
                  getRowKey={(asset) => asset.value}
                  titleHeader="Asset"
                  title={(asset) => (
                    <Link className="underline" to={assetPath(asset.value)}>
                      {asset.value}
                    </Link>
                  )}
                  columns={[
                    {
                      key: "findings",
                      header: "Findings",
                      align: "end",
                      render: (asset) => asset.findings.length,
                    },
                  ]}
                />
                {!assets.length && (
                  <p className="py-6 text-sm text-muted-foreground">
                    No asset values in imported evidence
                  </p>
                )}
              </ChartFrame>
            </ChartBand>
            <ChartBand>
              <ChartFrame
                span={8}
                icon="compliance"
                title="Compliance readiness"
                caption="Controls with linked evidence"
                action={
                  <Link className={quietLink} to="/compliance">
                    View controls
                  </Link>
                }
              >
                {readiness.isError ? (
                  <div role="alert" className="space-y-3">
                    <p>{readiness.error.message}</p>
                    <Button
                      variant="outline"
                      onClick={() => void readiness.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : readiness.isLoading ? (
                  <p role="status">Reading controls…</p>
                ) : (
                  <div className="space-y-4">
                    {readiness.data?.frameworks.map((framework) => {
                      const total = framework.controls.length;
                      const linked = framework.controls.filter(
                        (control) => control.evidence.length > 0,
                      ).length;
                      return (
                        <div key={framework.key}>
                          <p className="flex flex-wrap justify-between gap-2 text-sm">
                            <span>{framework.label}</span>
                            <span className="tabular-nums">
                              {linked} of {total}
                            </span>
                          </p>
                          <progress
                            aria-label={
                              framework.label + " controls with linked evidence"
                            }
                            max={total || 1}
                            value={linked}
                            className="mt-2 h-1 w-full accent-primary"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </ChartFrame>
              <ChartFrame
                span={4}
                icon="findings"
                title="Severity breakdown"
                caption="Open findings in this scope"
              >
                <DonutChart
                  size={188}
                  centerValue={open.length}
                  centerLabel="Open"
                  segments={segments}
                  emptyIcon="findings"
                  emptyLabel="No open findings"
                />
              </ChartFrame>
            </ChartBand>
            <ChartBand>
              <ChartFrame
                span={12}
                icon="runs"
                title="Recent assessments"
                action={
                  <Link to="/runs" className={quietLink}>
                    View assessments
                  </Link>
                }
              >
                <RecordTable
                  rows={recent}
                  getRowKey={(scope) => scope.id}
                  titleHeader="Assessment"
                  title={(scope) => (
                    <Link
                      to={"/runs/" + encodeURIComponent(scope.id)}
                      className="underline"
                    >
                      {scope.name}
                    </Link>
                  )}
                  columns={[
                    {
                      key: "updated",
                      header: "Updated",
                      render: (scope) =>
                        new Date(scope.updatedAt).toLocaleDateString(),
                    },
                  ]}
                />
              </ChartFrame>
            </ChartBand>
          </div>
        </>
      )}
    </ListPageShell>
  );
}
