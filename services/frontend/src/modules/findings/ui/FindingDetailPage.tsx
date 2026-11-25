import { lazy, Suspense, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download } from "lucide-react";
import {
  Badge,
  Button,
  DetailBackLink,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailRailNote,
  DetailSection,
  RecordTable,
  SeverityBadge,
  StatusTabs,
} from "@null-ai/design-tokens/ui";
import {
  evidenceURL,
  projectAPI,
  useLocal,
  type RiskState,
} from "../../../local";
import { RISK_STATE_LABELS, riskStateLabel } from "../../risks/riskState";
import { CvssScoreBadge } from "./components/CvssScoreBadge";

const ReviewText = lazy(() => import("../../compliance/ui/ReviewText"));

function EvidenceViewer({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ["original-evidence", url],
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new Error("The evidence file could not be opened.");
      return response.text();
    },
    enabled: open,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer px-5 py-3 text-xs font-medium">
        Preview original file
      </summary>
      {open &&
        (preview.error ? (
          <p role="alert" className="notice">
            {preview.error.message}
          </p>
        ) : (
          <pre className="scrollbar-slim max-h-96 overflow-auto bg-surface-inset p-4 font-mono text-[11px] leading-relaxed text-foreground">
            {preview.isLoading ? "Loading file…" : preview.data}
          </pre>
        ))}
    </details>
  );
}

function ProseSection({ label, value }: { label: string; value: string }) {
  return (
    <DetailSection label={label}>
      <div className="max-w-[72ch] text-[15px] leading-8 text-foreground">
        <Suspense fallback={<p className="whitespace-pre-wrap">{value}</p>}>
          <ReviewText text={value} />
        </Suspense>
      </div>
    </DetailSection>
  );
}

export default function FindingDetailPage({
  findingId,
}: {
  findingId: string;
}) {
  const { id: scopeId, project, refresh } = useLocal();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("overview");
  const finding = project?.findings.find((f) => f.id === findingId);
  const updateFinding = useMutation({
    mutationFn: (state: RiskState) =>
      projectAPI(
        scopeId,
        "/findings/" + encodeURIComponent(findingId),
        "PATCH",
        { state },
      ),
    onSuccess: refresh,
  });
  if (!finding || !project) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background font-mono uppercase tracking-widest text-foreground">
        <AlertTriangle className="mb-4 h-12 w-12 text-muted-foreground" />
        <p>Risk not found</p>
        <Button
          onClick={() => navigate("/risks")}
          className="mt-4"
          variant="outline"
        >
          Return to inbox
        </Button>
      </div>
    );
  }
  const events = finding.history;
  const importedAt = events.find((e) => e.type === "imported")?.createdAt;
  const evidence = project.artifacts.filter((file) =>
    finding.evidence.some((e) => e.id === file.id),
  );
  const location = finding.location;
  const line = location?.startLine
    ? ":" +
      location.startLine +
      (location.endLine && location.endLine !== location.startLine
        ? "–" + location.endLine
        : "")
    : "";
  const rail = (
    <DetailRailBlock>
      <div className="pb-6">
        <h3 className="mb-4 border-b border-border/70 pb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
          Workflow
        </h3>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="risk-status"
              className="mb-1 block text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              Current status
            </label>
            <select
              id="risk-status"
              value={finding.state}
              disabled={updateFinding.isPending}
              onChange={(e) =>
                updateFinding.mutate(e.target.value as RiskState)
              }
              className="h-10 w-full border border-border bg-input px-3 text-xs uppercase text-foreground outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {Object.entries(RISK_STATE_LABELS).map(([key, label]) => (
                <option key={key} value={key} className="bg-background">
                  {label}
                </option>
              ))}
            </select>
          </div>
          {updateFinding.error && (
            <p className="notice" role="alert">
              {updateFinding.error.message}
            </p>
          )}
          <DetailRailNote title="Local triage">
            Choose a status to record your assessment in the finding history.
          </DetailRailNote>
        </div>
      </div>
    </DetailRailBlock>
  );
  return (
    <DetailPageShell
      backLink={
        <DetailBackLink
          label="Back to risks"
          onClick={() => navigate("/risks")}
        />
      }
      displayId={
        <>
          ID {finding.id.split("-")[0]}
          {finding.id.includes(":") && ":" + finding.id.split(":").at(-1)}
          {importedAt && (
            <>
              {" "}
              · Imported{" "}
              <time dateTime={importedAt}>
                {new Date(importedAt).toLocaleDateString()}
              </time>
            </>
          )}
        </>
      }
      rail={rail}
    >
      <div className="space-y-6">
        <DetailHeader
          badges={
            <>
              <SeverityBadge severity={finding.severity} />
              <span className="border border-border px-2 py-1 text-xs text-muted-foreground">
                {riskStateLabel(finding.state)}
              </span>
              {finding.cvssScore != null && (
                <CvssScoreBadge
                  score={finding.cvssScore}
                  vector={finding.cvssVector}
                />
              )}
            </>
          }
          title={finding.title}
          subline={[
            finding.assetValue || location?.path,
            finding.source,
            project.name,
          ]}
        />
        <StatusTabs
          tone="bone"
          aria-label="Risk sections"
          value={activeTab}
          onChange={setActiveTab}
          items={[
            { value: "overview", label: "Overview" },
            { value: "evidence", label: "Evidence" },
            { value: "remediation", label: "Remediation" },
            { value: "history", label: "History" },
          ]}
        />
        <div className="min-h-[400px] max-w-[940px]">
          {activeTab === "overview" && (
            <div className="space-y-8">
              <ProseSection
                label="TL;DR"
                value={
                  finding.description ||
                  "The imported finding contains no summary."
                }
              />
              {(location || finding.ruleId || finding.assetValue) && (
                <DetailSection label="Affected context">
                  <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
                    {finding.assetValue && (
                      <>
                        <dt className="text-muted-foreground">
                          {finding.assetKind || "Asset"}
                        </dt>
                        <dd className="break-all">{finding.assetValue}</dd>
                      </>
                    )}
                    {location && (
                      <>
                        <dt className="text-muted-foreground">Source</dt>
                        <dd className="break-all font-mono">
                          {location.path}
                          {line}
                        </dd>
                      </>
                    )}
                    {finding.ruleId && (
                      <>
                        <dt className="text-muted-foreground">Rule</dt>
                        <dd className="break-all font-mono">
                          {finding.ruleId}
                        </dd>
                      </>
                    )}
                  </dl>
                </DetailSection>
              )}
              {finding.cweIds.length > 0 && (
                <DetailSection label="Classification">
                  <div className="flex flex-wrap gap-2">
                    {finding.cweIds.map((cwe) => (
                      <Badge
                        key={cwe}
                        className="rounded-none border border-border bg-background font-mono text-[10px] uppercase tracking-wider text-foreground"
                      >
                        {cwe}
                      </Badge>
                    ))}
                  </div>
                </DetailSection>
              )}
            </div>
          )}
          {activeTab === "evidence" && (
            <div className="space-y-8">
              <div className="border-t border-border/60 pt-5">
                <div className="flex flex-wrap items-center gap-x-8 gap-y-2 font-mono text-[12px] text-muted-foreground">
                  <span>
                    Evidence rows{" "}
                    <span className="text-foreground">
                      {finding.evidence.length}
                    </span>
                  </span>
                  <span>
                    Retained artifacts{" "}
                    <span className="text-foreground">{evidence.length}</span>
                  </span>
                </div>
              </div>
              <DetailSection label="Evidence chain">
                {evidence.length === 0 ? (
                  <p>No retained artifact.</p>
                ) : (
                  evidence.map((ev) => (
                    <div
                      key={ev.id}
                      className="overflow-hidden border-b border-border/60 last:border-b-0"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="break-all text-xs font-bold uppercase tracking-wider text-foreground">
                            {ev.name}
                          </span>
                          <Badge className="rounded-none border border-success/30 bg-success/10 font-mono text-[9px] uppercase tracking-wider text-success">
                            Full artifact
                          </Badge>
                          <time
                            dateTime={ev.createdAt}
                            className="text-[10px] uppercase tracking-wider text-muted-foreground"
                          >
                            {new Date(ev.createdAt).toLocaleString()}
                          </time>
                        </div>
                        <a
                          className="inline-flex items-center gap-2 text-sm underline"
                          href={evidenceURL(scopeId, ev.id)}
                          download
                          aria-label={"Download " + ev.name}
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download
                        </a>
                      </div>
                      <EvidenceViewer url={evidenceURL(scopeId, ev.id)} />
                    </div>
                  ))
                )}
              </DetailSection>
            </div>
          )}
          {activeTab === "remediation" && (
            <div className="space-y-8">
              <ProseSection
                label="Remediation"
                value={
                  finding.remediation ||
                  "The imported finding contains no remediation guidance."
                }
              />
              {location && (
                <DetailSection label="Affected code">
                  <code className="break-all">
                    {location.path}
                    {line}
                  </code>
                </DetailSection>
              )}
            </div>
          )}
          {activeTab === "history" && (
            <DetailSection label={`History (${events.length})`}>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No events recorded yet.
                </p>
              ) : (
                <RecordTable
                  rows={events}
                  getRowKey={(event) => event.id}
                  titleWidth="minmax(0,1.4fr)"
                  title={(event) =>
                    event.type === "imported"
                      ? "Evidence imported"
                      : "Status changed"
                  }
                  subtitle={(event) =>
                    event.fromStatus
                      ? riskStateLabel(event.fromStatus) +
                        " → " +
                        riskStateLabel(event.toStatus)
                      : riskStateLabel(event.toStatus)
                  }
                  columns={[
                    {
                      key: "at",
                      header: "When",
                      width: "160px",
                      mono: true,
                      align: "end",
                      showOnMobile: true,
                      render: (event) => (
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleString()}
                        </time>
                      ),
                    },
                  ]}
                />
              )}
            </DetailSection>
          )}
        </div>
      </div>
    </DetailPageShell>
  );
}
