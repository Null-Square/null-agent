import { lazy, Suspense, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import {
  Button,
  DetailHeader,
  DetailPageShell,
  DetailRailBlock,
  DetailSection,
  ListEmptyState,
  ListSkeleton,
  Modal,
  ModalContent,
  SeverityBadge,
  RecordTable,
  RunFindingList,
  StatusTabs,
} from "@null-ai/design-tokens/ui";
import {
  projectAPI,
  projectPath,
  useLocal,
  type Project,
} from "../../../local";
import { COMPLIANCE_FRAMEWORK_OPTIONS } from "../../security-ops/complianceFrameworks";
import SeverityProgressBar from "./SeverityProgressBar";
import RunActivityDashboard from "./components/RunActivityDashboard";
import { assetPath, recordedAssets } from "../../assets/recordedAssets";
import { isOpenRisk } from "../../risks/riskState";

const ReviewText = lazy(() => import("../../compliance/ui/ReviewText"));

const backLink = (
  <Link
    to="/runs"
    className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
  >
    <ArrowLeft className="h-3.5 w-3.5" />
    Back to Assessments
  </Link>
);

function workflowName(workflow: string) {
  return workflow === "code-review" ? "Code review" : "Compliance review";
}

function AssessmentDetail({ run }: { run: Project }) {
  const { select } = useLocal();
  const navigate = useNavigate();
  const [selectedTab, setActiveTab] = useState("overview");
  const [isGoalExpanded, setIsGoalExpanded] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const assets = recordedAssets(run);
  const openRiskCount = run.findings.filter(finding => isOpenRisk(finding.state)).length;
  const framework =
    COMPLIANCE_FRAMEWORK_OPTIONS.find(({ key }) => key === run.framework)
      ?.label ?? run.framework;
  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "plan", label: "Plan" },
    { value: "findings", label: "Risks", count: run.findings.length },
    { value: "assets", label: "Assets", count: assets.length },
    { value: "activity", label: "Activity" },
  ];

  return (
    <DetailPageShell
      displayId={run.id}
      backLink={backLink}
      rail={
        <DetailRailBlock label="Assessment">
          <Button
            data-tour="run-report"
            className="w-full"
            onClick={() => setIsReportOpen(true)}
          >
            View report
          </Button>
          <Button asChild variant="outline">
            <Link to="/compliance" onClick={() => select(run.id)}>
              Open compliance
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link
              to={"/runs/" + encodeURIComponent(run.id) + "/workbench"}
              onClick={() => select(run.id)}
            >
              Open workbench
            </Link>
          </Button>
        </DetailRailBlock>
      }
    >
      <div data-tour="run-content" className="space-y-6">
        <DetailHeader
          title={run.name}
          subline={["Local assessment", framework]}
        />
        {run.scope && (
          <div>
            <Button
              variant="ghost"
              onClick={() => setIsGoalExpanded(!isGoalExpanded)}
              aria-expanded={isGoalExpanded}
              className="px-0"
            >
              {isGoalExpanded ? "Hide objective" : "View objective"}
            </Button>
            {isGoalExpanded && (
              <p className="mt-2 border-l-2 border-border pl-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                {run.scope}
              </p>
            )}
          </div>
        )}
        <SeverityProgressBar findings={run.findings} />
        <StatusTabs
          tone="bone"
          aria-label="Assessment sections"
          value={selectedTab}
          onChange={setActiveTab}
          items={tabs}
          itemAttributes={(item) => ({ "data-tour": `run-tab-${item.value}` })}
        />
        <div
          className="w-full min-h-[400px]"
          role="tabpanel"
          aria-label={tabs.find((tab) => tab.value === selectedTab)?.label}
        >
          {selectedTab === "overview" && (
            <div className="space-y-6 animate-in fade-in duration-300">
              <div className="grid grid-cols-2 sm:grid-cols-4 [&>div]:px-5 [&>div]:py-4 [&>div]:border-l [&>div]:border-border [&>div:first-child]:border-l-0 [&>div:nth-child(3)]:border-l-0 sm:[&>div:nth-child(3)]:border-l">
                {[
                  ["Evidence files", run.artifacts.length],
                  ["Risks", run.findings.length],
                  ["Saved reviews", run.reviews.length],
                  ["Updated", new Date(run.updatedAt).toLocaleDateString()],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                      {label}
                    </div>
                    <div className="text-sm tabular-nums text-foreground">
                      {value}
                    </div>
                  </div>
                ))}
              </div>
              <DetailSection label="Executive summary">
                <p>
                  {run.findings.length
                    ? `${openRiskCount} open · ${run.findings.length - openRiskCount} accepted, resolved, or marked false positive.`
                    : "No findings have been imported for this assessment."}
                </p>
              </DetailSection>
              <DetailSection label="Saved reviews">
                {run.reviews.length ? (
                  [...run.reviews].reverse().map((review) => (
                    <details
                      key={review.id}
                      className="border-b border-border py-4"
                    >
                      <summary className="cursor-pointer break-words text-sm font-semibold">
                        {workflowName(review.workflow)} Â· {review.model} Â·{" "}
                        {new Date(review.createdAt).toLocaleString()}
                      </summary>
                      <Suspense
                        fallback={
                          <p className="whitespace-pre-wrap">{review.text}</p>
                        }
                      >
                        <ReviewText text={review.text} />
                      </Suspense>
                    </details>
                  ))
                ) : (
                  <p>No reviews have been saved for this scope.</p>
                )}
              </DetailSection>
            </div>
          )}
          {selectedTab === "findings" && (
            <RunFindingList
              className="animate-in fade-in duration-300"
              emptyTitle="No findings recorded"
              emptyMessage="Risks appear here when you import a scanner report with findings."
              findings={run.findings.map((finding) => ({
                id: finding.id,
                title: finding.title,
                severity: finding.severity,
                target:
                  finding.assetValue ??
                  finding.location?.path ??
                  finding.target,
              }))}
              onSelect={(finding) => {
                select(run.id);
                navigate("/risks/" + encodeURIComponent(finding.id));
              }}
            />
          )}
          {selectedTab === "plan" && (
            <div className="space-y-6 py-6">
              <DetailSection label="Objective">
                <p className="whitespace-pre-wrap">
                  {run.scope || "No objective recorded."}
                </p>
              </DetailSection>
              <DetailSection label="Scope">
                <Link
                  to={"/scopes/" + encodeURIComponent(run.id)}
                  className="underline"
                >
                  View scope
                </Link>
              </DetailSection>
            </div>
          )}
          {selectedTab === "assets" &&
            (assets.length ? (
              <RecordTable
                rows={assets}
                getRowKey={(asset) => asset.value}
                titleHeader="Asset"
                title={(asset) => asset.value}
                rowActionLabel={(asset) => "Open asset: " + asset.value}
                onRowClick={(asset) => {
                  select(run.id);
                  navigate(assetPath(asset.value));
                }}
                columns={[
                  {
                    key: "focus",
                    header: "Focus",
                    render: (asset) => <SeverityBadge severity={asset.focus} />,
                  },
                  {
                    key: "risks",
                    header: "Risks",
                    render: (asset) => asset.findings.length,
                  },
                ]}
              />
            ) : (
              <ListEmptyState
                icon="assets"
                title="No assets recorded"
                description="Assets appear when an imported finding names an asset."
              />
            ))}
          {selectedTab === "activity" && <RunActivityDashboard run={run} />}
        </div>
      </div>
      {isReportOpen && (
        <AssessmentReport
          scopeId={run.id}
          name={run.name}
          close={() => setIsReportOpen(false)}
        />
      )}
    </DetailPageShell>
  );
}

function AssessmentReport({
  scopeId,
  name,
  close,
}: {
  scopeId: string;
  name: string;
  close: () => void;
}) {
  const path = "/api" + projectPath(scopeId);
  const url = path + "/report.md";
  const report = useQuery({
    queryKey: ["assessment-report", url],
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = await fetch(url, { signal });
      if (!result.ok) throw new Error("Could not open the assessment report.");
      return result.text();
    },
  });
  return (
    <Modal isOpen onClose={close} title="Assessment report" size="lg">
      <ModalContent>
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <p className="text-sm text-muted-foreground">{name}</p>
          <a href={url} download className="text-sm underline">
            Download Markdown report
          </a>
          <a href={path + "/report.sarif"} download className="text-sm underline">
            Download SARIF
          </a>
        </div>
        {report.isError ? (
          <p role="alert">{report.error.message}</p>
        ) : report.data ? (
          <Suspense fallback={<p role="status">Opening report…</p>}>
            <ReviewText text={report.data} />
          </Suspense>
        ) : (
          <p role="status">Opening report…</p>
        )}
      </ModalContent>
    </Modal>
  );
}

export default function RunDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const { id: activeId, select } = useLocal();
  const assessment = useQuery({
    queryKey: ["scope", id],
    queryFn: () => projectAPI<Project>(id),
  });
  useEffect(() => {
    if (assessment.data && activeId !== assessment.data.id)
      select(assessment.data.id);
  }, [activeId, assessment.data, select]);

  if (assessment.isLoading) return <ListSkeleton label="Reading assessment" />;
  if (!assessment.data)
    return (
      <DetailPageShell backLink={backLink}>
        <ListEmptyState
          icon="runs"
          title="Assessment unavailable"
          description={
            assessment.error?.message ?? "This scope could not be opened."
          }
          action={
            <Button onClick={() => void assessment.refetch()}>Retry</Button>
          }
        />
      </DetailPageShell>
    );
  return <AssessmentDetail key={assessment.data.id} run={assessment.data} />;
}
