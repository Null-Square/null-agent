import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Terminal,
  Square,
  FileText,
  Download,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  Clock,
  CheckCircle,
  RefreshCw,
  MessageSquareMore,
  Network,
  Globe,
  ArrowRight,
  X,
} from "lucide-react";
import {
  Button,
  Badge,
  cn,
  ListEmptyState,
  ListMeta,
  RecordTable,
  RunFindingList,
  Textarea,
  RunStatusBadge,
  StatusPill,
} from '@null-ai/design-tokens/ui';
import { resolveSessionPresentation } from "@null-ai/contracts";
import {
  useRunDetailQuery,
  useRunFindingsQuery,
  useRunInventoryDiffQuery,
  useRunCodeReviewQuery,
  useApproveRunMutation,
  useRejectRunMutation,
  useRequestPlanFeedbackMutation,
  useComplianceReadinessQuery,
} from "@/modules/security-ops/api";
import {
  useSessionDetailsQuery,
  useSessionActions,
} from "@modules/sessions";
import { resolveEffectiveSessionRuntime } from "@modules/sessions/lib/sessionStateUtils";
import RunReportPdfDocument from "./components/RunReportPdfDocument";
import RunActivityDashboard from "./components/RunActivityDashboard";
import AgentsTab from "./components/AgentsTab";
import { TimeAgo } from "@shared/ui/TimeAgo";
import type { CodeReviewFinding, Finding } from "@/modules/security-ops/types";
import { MarkdownScanReport } from "@modules/chat";
import { SessionActionButtons } from "@modules/sessions/ui/SessionActionButtons";
import { ExecutionTargetIndicator } from "@shared/ui/ExecutionTargetIndicator";
import { useAppPaths } from "@shared/contexts/AppPathContext";
import { useOrgPermissions } from "@modules/permissions";
import { fetchApi } from "@shared/api";
import { toastService } from "@shared/services/toastService";
import {
  isRunAwaitingPlanApproval,
  resolveRunSessionId,
} from "../lib/runState";
import { stripMissionEnvelopeFromPlan } from "../lib/missionEnvelopePlan";
import { queuedReasonLabel } from "../lib/queuePresentation";
import { isTerminalRunStatus } from "../lib/runStatus";


const reportDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDuration(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string {
  if (!startedAt) return "-";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "< 1 minute";
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours} hours`;
}

function resolvePdfDownloadName(
  sessionId: string,
  fileName?: string | null,
): string {
  const fallback = `report-${sessionId}.pdf`;
  if (!fileName) return fallback;
  if (/\.pdf$/i.test(fileName)) return fileName;
  if (/\.(md|markdown)$/i.test(fileName)) {
    return fileName.replace(/\.(md|markdown)$/i, ".pdf");
  }
  return `${fileName}.pdf`;
}

function formatReportGeneratedAt(value: string | null | undefined): string {
  if (!value) return "In progress";
  return reportDateFormatter.format(new Date(value));
}

/* Report PDF Popup */
function ReportPopup({
  sessionId,
  markdown,
  downloadFileName,
  reportTitle,
  scopeName,
  runnerName,
  runStatus,
  generatedAt,
  onClose,
}: {
  sessionId: string;
  markdown?: string | null;
  downloadFileName?: string;
  reportTitle?: string | null;
  scopeName?: string | null;
  runnerName?: string | null;
  runStatus?: string | null;
  generatedAt?: string | null;
  onClose: () => void;
}) {
  const pdfDocumentRef = useRef<HTMLDivElement | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const resolvedDownloadName = useMemo(
    () => resolvePdfDownloadName(sessionId, downloadFileName),
    [downloadFileName, sessionId],
  );
  const generatedAtLabel = useMemo(
    () => formatReportGeneratedAt(generatedAt),
    [generatedAt],
  );
  const resolvedPdfEndpoint = `/ai-agent/sessions/${sessionId}/report/pdf`;

  const createGeneratedPdf = useCallback(async (): Promise<Blob> => {
    if (!markdown || !pdfDocumentRef.current) {
      throw new Error("Report markdown unavailable");
    }

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    const waitForMermaid = async () => {
      const startedAt = Date.now();

      while (Date.now() - startedAt < 3_000) {
        const diagrams = Array.from(
          pdfDocumentRef.current?.querySelectorAll(".mermaid-diagram") ?? [],
        );
        if (
          diagrams.length === 0 ||
          diagrams.every((node) => node.querySelector("svg"))
        ) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 75));
      }
    };

    await waitForMermaid();

    const waitForReportImages = async () => {
      const startedAt = Date.now();

      while (Date.now() - startedAt < 5_000) {
        const pendingImages = pdfDocumentRef.current?.querySelectorAll(
          '[data-report-image-status="loading"]',
        );
        if (!pendingImages || pendingImages.length === 0) {
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 75));
      }
    };

    await waitForReportImages();

    const { createPDFBlob } = await import("@shared/lib/pdf");

    return createPDFBlob(pdfDocumentRef.current, {
      filename: resolvedDownloadName,
      margin: [0, 0, 0, 0],
      html2canvas: {
        scale: 1.6,
        useCORS: true,
        logging: false,
        backgroundColor: "#ffffff",
        windowWidth: 794,
      },
      jsPDF: {
        unit: "mm",
        format: "a4",
        orientation: "portrait",
      },
      pagebreak: {
        mode: ["css", "legacy"],
      },
    });
  }, [markdown, resolvedDownloadName]);

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  useEffect(() => {
    let isMounted = true;
    let objectUrl: string | null = null;

    const assignPreviewBlob = (blob: Blob) => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
      objectUrl = URL.createObjectURL(blob);
      setPdfBlob(blob);
      setPdfUrl(objectUrl);
    };

    const loadGeneratedPreview = async () => {
      if (!markdown) {
        if (isMounted) {
          setPdfBlob(null);
          setPdfUrl(null);
          setPdfError("Report not available yet.");
          setIsLoadingPdf(false);
        }
        return;
      }

      try {
        const blob = await createGeneratedPdf();
        if (!isMounted) {
          return;
        }
        assignPreviewBlob(blob);
        setPdfError(null);
      } catch {
        if (!isMounted) {
          return;
        }
        setPdfBlob(null);
        setPdfUrl(null);
        setPdfError("PDF preview unavailable. Showing markdown report.");
      } finally {
        if (isMounted) {
          setIsLoadingPdf(false);
        }
      }
    };

    setIsLoadingPdf(true);
    setPdfUrl(null);
    setPdfBlob(null);
    setPdfError(null);

    void (async () => {
      try {
        const response = await fetchApi.get<Blob>(
          resolvedPdfEndpoint,
          { responseType: "blob" },
        );
        if (!isMounted) {
          return;
        }
        assignPreviewBlob(response.data as unknown as Blob);
        setPdfError(null);
        setIsLoadingPdf(false);
      } catch {
        await loadGeneratedPreview();
      }
    })();

    return () => {
      isMounted = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [createGeneratedPdf, markdown, resolvedPdfEndpoint]);

  const handleDownload = async () => {
    try {
      setIsDownloading(true);
      if (pdfBlob) {
        downloadBlob(pdfBlob, resolvedDownloadName);
        toastService.success("PDF downloaded");
        return;
      }

      try {
        const response = await fetchApi.get<Blob>(
          resolvedPdfEndpoint,
          { responseType: "blob" },
        );
        downloadBlob(response.data as unknown as Blob, resolvedDownloadName);
        toastService.success("PDF downloaded");
        return;
      } catch {
        // Fall through to client-side PDF generation.
      }

      if (!markdown) {
        toastService.error("Report download unavailable");
        return;
      }

      const generatedBlob = await createGeneratedPdf();
      downloadBlob(generatedBlob, resolvedDownloadName);
      toastService.success("PDF downloaded");
    } catch {
      toastService.error("Failed to download PDF");
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[5px]"
      onClick={onClose}
    >
      <div
        className="relative flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-none border border-border bg-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
          <h3 className="text-sm font-bold text-heading   font-sans">
            Mission Report
          </h3>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={handleDownload}
              disabled={isDownloading}
              className="border border-border bg-muted text-foreground hover:bg-foreground hover:text-background rounded-none text-xs font-bold  gap-2"
            >
              {isDownloading ? (
                <span aria-hidden className="ns-live-mark h-2 w-2 bg-current" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {isDownloading ? "Preparing..." : "Download PDF"}
            </Button>
            <button
              onClick={onClose}
              className="rounded-none p-2 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {isLoadingPdf ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex items-center gap-3 text-sm font-bold   text-muted-foreground font-sans">
                <span aria-hidden className="ns-live-mark h-2 w-2 bg-foreground" />{" "}
                Loading PDF...
              </div>
            </div>
          ) : pdfUrl ? (
            <iframe
              title="Run report PDF preview"
              src={`${pdfUrl}#toolbar=1&navpanes=0&scrollbar=1&view=FitH`}
              className="h-full w-full bg-white"
            />
          ) : markdown ? (
            <div className="overflow-auto h-full p-6">
              {pdfError && (
                <div className="rounded-none border border-warning/45 bg-warning/15 px-3 py-2 text-sm font-bold   text-foreground font-sans mb-4">
                  {pdfError}
                </div>
              )}
              <MarkdownScanReport markdown={markdown} title="" />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground font-sans text-sm  ">
              Report not available yet.
            </div>
          )}
        </div>
      </div>

      {markdown ? (
        <div
          className="fixed left-[-20000px] top-0 z-[-1] w-[794px] bg-white"
          aria-hidden="true"
        >
          <div ref={pdfDocumentRef}>
            <RunReportPdfDocument
              title={reportTitle}
              markdown={markdown}
              sessionId={sessionId}
              scopeName={scopeName}
              runnerName={runnerName}
              status={runStatus}
              generatedAtLabel={generatedAtLabel}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* Severity Progress Bar */
function SeverityProgressBar({ findings }: { findings: Array<{ severity?: string | null }> }) {
  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of findings) {
      const sev = (f.severity ?? "info").toLowerCase() as keyof typeof c;
      if (sev in c) c[sev]++;
    }
    return c;
  }, [findings]);

  const total = findings.length;
  if (total === 0) return null;

  const segments = [
    {
      key: "critical",
      count: counts.critical,
      color: "bg-destructive",
      dotColor: "bg-destructive",
      label: "critical",
    },
    {
      key: "high",
      count: counts.high,
      color: "bg-high",
      dotColor: "bg-high",
      label: "high",
    },
    {
      key: "medium",
      count: counts.medium,
      color: "bg-medium",
      dotColor: "bg-medium",
      label: "medium",
    },
    {
      key: "low",
      count: counts.low,
      color: "bg-low",
      dotColor: "bg-low",
      label: "low",
    },
    {
      key: "info",
      count: counts.info,
      color: "bg-muted-foreground",
      dotColor: "bg-muted-foreground",
      label: "info",
    },
  ].filter((s) => s.count > 0);

  return (
    <div className="mb-8">
      <div className="flex items-center gap-4 mb-3">
        <span className="text-3xl font-bold text-heading">{total}</span>
        <span className="text-xs font-sans text-muted-foreground  ">
          Risks
        </span>
        <div className="flex items-center gap-4 ml-4">
          {segments.map((s) => (
            <span
              key={s.key}
              className="flex items-center gap-1.5 text-sm font-sans   text-muted-foreground"
            >
              <span className={cn("h-2 w-2", s.dotColor)} />
              <span className="font-bold">{s.count}</span> {s.label}
            </span>
          ))}
        </div>
      </div>
      <div className="h-1.5 w-full bg-border/30 overflow-hidden flex">
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("h-full", s.color)}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

type RunDetailPageProps = {
  runId?: string;
  backPath?: string;
  backLabel?: string;
  notFoundActionLabel?: string;
};

/* Main Page */
export default function RunDetailPage({
  runId,
  backPath = "/runs",
  backLabel = "Back to Assessments",
  notFoundActionLabel = "Return to Assessments",
}: RunDetailPageProps) {
  const params = useParams<{ id: string }>();
  const id = runId ?? params.id;
  const navigate = useNavigate();
  const paths = useAppPaths();
  const [activeTab, setActiveTab] = useState("overview");
  const [isReportPopupOpen, setIsReportPopupOpen] = useState(false);
  const [isFeedbackComposerOpen, setIsFeedbackComposerOpen] = useState(false);
  const [planFeedback, setPlanFeedback] = useState("");
  const [isGoalExpanded, setIsGoalExpanded] = useState(false);

  // Run data
  const { data: run, isLoading: isLoadingRun } = useRunDetailQuery(id ?? "", {
    enabled: !!id,
    refetchInterval: (query) =>
      isTerminalRunStatus(query.state.data?.status) ? false : 5_000,
  });
  const isCodeReview = run?.workflowDiscipline === "code_review";
  const { data: runFindings } = useRunFindingsQuery(id ?? "", {
    enabled: Boolean(run) && !isCodeReview,
  });
  const { data: inventoryDiff } = useRunInventoryDiffQuery(id ?? "", {
    enabled: Boolean(run) && !isCodeReview,
  });
  const { data: codeReviewBundle } = useRunCodeReviewQuery(id ?? "", {
    enabled: Boolean(run) && isCodeReview,
    refetchInterval: isCodeReview && !isTerminalRunStatus(run?.status)
      ? 5_000
      : false,
  });
  const isCompliance = run?.workflowDiscipline === "compliance";
  const { data: complianceReadiness } = useComplianceReadinessQuery(run?.scopeId ?? null, {
    enabled: isCompliance && Boolean(run?.scopeId),
  });
  // Compliance runs record control checks/requests, not findings — collect what this run did.
  // Declared before any early return so hook order stays stable across loading/loaded states.
  const complianceEntries = useMemo(() => {
    if (!isCompliance || !complianceReadiness) return [];
    const runId = id ?? "";
    const entries: Array<{
      frameworkKey: string;
      controlId: string;
      title: string;
      status: "passed" | "failed" | "needs_action" | "needs_context" | "not_checked";
      detail: string;
      basis: string | null;
    }> = [];
    for (const framework of complianceReadiness.frameworks) {
      for (const control of framework.controls) {
        const runChecks = control.controlChecks.filter((c) => c.runId === runId);
        const runRequests = control.actionRequests.filter((r) => r.runId === runId);
        if (runChecks.length === 0 && runRequests.length === 0) continue;
        const latest = runChecks[0] ?? null;
        const hasOpenRequest = runRequests.some((r) =>
          ["open", "fulfilled", "insufficient", "contradicted"].includes(r.status),
        );
        let status: (typeof entries)[number]["status"];
        let detail: string;
        if (latest?.verdict === "pass") {
          status = "passed";
          detail = latest.reason;
        } else if (latest?.verdict === "fail") {
          status = "failed";
          detail = latest.reason;
        } else if (hasOpenRequest) {
          status = "needs_action";
          detail = runRequests[0]?.title ?? runRequests[0]?.reason ?? "Action request raised.";
        } else if (latest?.verdict === "needs_context") {
          status = "needs_context";
          detail = latest.reason;
        } else {
          status = "not_checked";
          detail = latest?.reason ?? "Not attempted in this run.";
        }
        entries.push({
          frameworkKey: framework.key,
          controlId: control.id,
          title: control.title,
          status,
          detail,
          basis: latest?.basis ?? null,
        });
      }
    }
    return entries.sort((a, b) => a.controlId.localeCompare(b.controlId, undefined, { numeric: true }));
  }, [isCompliance, complianceReadiness, id]);
  const approveRun = useApproveRunMutation();
  const rejectRun = useRejectRunMutation();
  const requestPlanFeedback = useRequestPlanFeedbackMutation();
  const isTerminalRun = isTerminalRunStatus(run?.status);

  // Session data
  const sessionId = resolveRunSessionId(run);
  const { data: session } = useSessionDetailsQuery(sessionId ?? "", {
    enabled: Boolean(sessionId),
    // Keep the terminal session projection fresh for historical observability.
    // Execution controls are suppressed below once the owning run is terminal.
    refetchInterval: 5_000,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const { stopSession, startSession, isStopping, isStarting } =
    useSessionActions();

  const isPlannerPhase =
    Boolean(run?.plannerSessionId) && !run?.executorSessionId;
  const isPlanRevisionInFlight =
    Boolean(run?.plan?.trim()) && run?.status === "running" && isPlannerPhase;
  const isPlanActionPending =
    approveRun.isPending ||
    rejectRun.isPending ||
    requestPlanFeedback.isPending;
  const isAwaitingPlanApproval = isRunAwaitingPlanApproval(run);
  const permissions = useOrgPermissions();
  const canApproveRun = permissions.has("org.run.approve");
  const hasSessionRuntimeState = Boolean(
    session &&
      (session.status ||
        session.desiredExecution ||
        session.condition ||
        session.pause_reason ||
        session.blocked_reason ||
        session.interaction_type),
  );
  const effectiveSessionRuntime = resolveEffectiveSessionRuntime({
    desiredExecution: session?.desiredExecution,
    condition: session?.condition,
    conditionReason: session?.conditionReason,
    status: session?.status,
    pauseReason: session?.pause_reason ?? null,
    interactionType: session?.interaction_type ?? "none",
    blockedReason: session?.blocked_reason ?? null,
  });
  const effectiveSessionBlockedReason = effectiveSessionRuntime.blockedReason;
  const sessionStatus =
    (hasSessionRuntimeState ? effectiveSessionRuntime.status : undefined) ??
    (run?.status === "running" ||
    run?.status === "paused" ||
    run?.status === "completed" ||
    run?.status === "failed"
      ? run.status
      : undefined);
  const sessionPauseReason = hasSessionRuntimeState
    ? effectiveSessionRuntime.pauseReason
    : (run?.pauseReason ?? null);
  const reportMarkdown = isCodeReview
      ? codeReviewBundle?.report?.markdown
      : session?.report;
  const summaryMarkdown = isCodeReview
      ? codeReviewBundle?.report?.executiveSummary
      : session?.summary;
  const visiblePlanMarkdown = useMemo(
    () => stripMissionEnvelopeFromPlan(run?.plan),
    [run?.plan],
  );


  /**
   * A report exists only when the agent wrote one.
   *
   * `reportMarkdown` can be present on a run that failed — a partial document
   * the agent had started, or a synthesised one — and offering "View report"
   * for it promises a deliverable that does not exist. A run that did not reach
   * a conclusion has no report to view, and the Activity and Findings tabs are
   * where its evidence actually is.
   */
  const hasReport =
    Boolean(reportMarkdown?.trim()) &&
    run?.status !== 'failed' &&
    run?.status !== 'cancelled' &&
    run?.status !== 'canceled';
  const reportDocumentId = sessionId;
  const showWorkbenchAction = Boolean(sessionId);
  const workbenchPath = id ? paths.runWorkbench(id) : backPath;
  const handleRequestPlanChanges = () => {
    if (!id || !planFeedback.trim()) {
      toastService.error("Add revision feedback before requesting changes");
      return;
    }
    requestPlanFeedback.mutate(
      { runId: id, feedback: planFeedback.trim() },
      {
        onSuccess: () => {
          setIsFeedbackComposerOpen(false);
          setPlanFeedback("");
          setActiveTab("plan");
          toastService.success("Planner is revising the plan");
        },
        onError: () => toastService.error("Failed to send plan feedback"),
      },
    );
  };

  const workerTaskCount = session?.workerTasks?.length ?? 0;
  const hasMultipleAgents = workerTaskCount > 0;
  const isSubAgentSession = session?.coordination?.role === "worker";
  const showAgentsTab = Boolean(sessionId) && (hasMultipleAgents || isSubAgentSession);

  useEffect(() => {
    if (activeTab === "agents" && !showAgentsTab) {
      setActiveTab("overview");
    }
  }, [activeTab, showAgentsTab]);

  if (isLoadingRun) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center font-sans   text-sm text-muted-foreground ">
        /// LOADING ASSESSMENT DATA...
      </div>
    );
  }

  if (!run) {
    return (
      <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center font-sans   text-sm">
        <Terminal className="h-12 w-12 text-foreground mb-4" />
        <p>Run Not Found</p>
        <Link
          to={backPath}
          className="mt-4 text-foreground underline hover:text-foreground"
        >
          {notFoundActionLabel}
        </Link>
      </div>
    );
  }

  const codeReviewFindings = codeReviewBundle?.findings ?? [];
  const findings = isCodeReview
    ? codeReviewFindings.filter((finding) => finding.state === "validated")
    : runFindings ?? [];
  const duration = formatDuration(run.startedAt, run.completedAt);
  const sessionPresentation = resolveSessionPresentation({
    desiredExecution: hasSessionRuntimeState ? effectiveSessionRuntime.desiredExecution : undefined,
    condition: hasSessionRuntimeState ? effectiveSessionRuntime.condition : undefined,
    conditionReason: hasSessionRuntimeState ? effectiveSessionRuntime.conditionReason : undefined,
    status: sessionStatus,
    pauseReason: sessionPauseReason,
    interactionType: 'none',
    blockedReason: effectiveSessionBlockedReason,
    blockedMetaCode: session?.blocked_meta?.code,
  });
  const showRunnerUnavailableBanner = sessionPresentation.kind === "waiting_runner";
  const authoritativeSessionIsUnblocked =
    hasSessionRuntimeState &&
    effectiveSessionRuntime.status !== "paused" &&
    !effectiveSessionBlockedReason &&
    !effectiveSessionRuntime.pauseReason;
  const runHasSystemRecovery =
    run.status === "paused" && run.pauseReason === "system";
  const showSystemRecoveryBanner =
    !authoritativeSessionIsUnblocked &&
    (sessionPresentation.kind === "recovering" || runHasSystemRecovery);
  const systemRecoveryReason =
    sessionPresentation.systemPauseCauseLabel ??
    "temporary runtime interruption";
  const tabs = [
    { id: "overview", label: "Overview", icon: FileText },
    ...(visiblePlanMarkdown
      ? [{ id: "plan", label: "Plan", icon: FileText }]
      : []),
    // Compliance runs record control checks, not findings/assets — show a Compliance tab instead.
    ...(isCompliance
      ? [
          {
            id: "compliance",
            label: "Compliance",
            icon: ShieldCheck,
            count: complianceEntries.length,
          },
        ]
      : [
          // One Risks tab whatever the run tested. It used to read "Code
          // Findings" on a code review, which asked the customer to hold two
          // words for one idea — and its count read the pentest findings array,
          // which is empty on exactly those runs, so it always showed 0.
          // Audit §12B.
          {
            id: "findings",
            label: "Risks",
            icon: ShieldAlert,
            count: isCodeReview ? codeReviewFindings.length : findings.length,
          },
          // No Assets tab on a code review. It does write a `repository` asset
          // row for agent memory. The customer asset API excludes that kind.
          // This is the intended behaviour, not an oversight. Audit §12B.
          ...(isCodeReview ? [] : [{
            id: "assets",
            label: "Assets",
            icon: Globe,
            count: (inventoryDiff?.added ?? []).length,
          }]),
        ]),
    {
      id: "agents",
      label: "Agents",
      icon: Network,
      count: hasMultipleAgents ? workerTaskCount + 1 : undefined,
    },
    { id: "activity", label: "Activity", icon: Terminal },
  ].filter((tab) => tab.id !== "agents" || showAgentsTab);

  const complianceStatusView = {
    passed: { label: "Passed", icon: CheckCircle, cls: "text-success bg-success/10 border-success/30" },
    failed: { label: "Failed", icon: XCircle, cls: "text-destructive bg-destructive/10 border-destructive/30" },
    needs_action: { label: "Needs action", icon: AlertTriangle, cls: "text-warning bg-warning/10 border-warning/30" },
    needs_context: { label: "Needs context", icon: AlertTriangle, cls: "text-warning bg-warning/10 border-warning/30" },
    not_checked: { label: "Not attempted", icon: Clock, cls: "text-muted-foreground bg-muted/30 border-border" },
  } as const;

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground pb-[100px]">

      <div data-tour="run-content" className="relative z-10 max-w-[1600px] mx-auto p-4 lg:p-10 pt-8 lg:pt-16">
        <div className="mb-8 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              to={backPath}
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground   transition-colors font-bold font-sans"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
            </Link>
          </div>
          {hasReport && reportDocumentId && (
            <Button
              data-tour="run-report"
              size="lg"
              onClick={() => setIsReportPopupOpen(true)}
              className="shrink-0"
            >
              View report
            </Button>
          )}
        </div>

        <div className="mb-6 flex flex-col xl:flex-row xl:items-start justify-between gap-6">
          <div className="flex-1">
            <div
              className={cn(
                "group inline-flex items-center gap-4 transition-colors",
                run.goal && "cursor-pointer",
              )}
              onClick={() => {
                if (run.goal) setIsGoalExpanded((prev) => !prev);
              }}
              title={run.goal ? "Click to toggle goal details" : undefined}
            >
              <h1 className="text-[clamp(1.55rem,2.7vw,2.25rem)] font-extrabold tracking-[-0.035em] text-foreground mb-3 leading-[1.08] group-hover:text-foreground/90 transition-colors">
                {run.title || "Untitled assessment"}
              </h1>
            </div>
            {isGoalExpanded && run.goal && (
              <div className="text-sm text-foreground/80 leading-relaxed border-l-[3px] border-border pl-5 py-2 mb-4 xl:max-w-2xl bg-surface-1/50 ">
                {run.goal}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {hasSessionRuntimeState ? (
                <StatusPill
                  tone={
                    sessionPresentation.kind === "running" || sessionPresentation.kind === "recovering"
                      ? "signal"
                      : sessionPresentation.kind === "completed"
                        ? "success"
                        : sessionPresentation.kind.startsWith("waiting_")
                          ? "warning"
                          : "neutral"
                  }
                  pulse={sessionPresentation.pulseAnimate}
                >
                  {sessionPresentation.label}
                </StatusPill>
              ) : (
                <RunStatusBadge
                  status={run.status}
                  pauseReason={run.pauseReason}
                  interactionType={run.interactionType}
                />
              )}
              {run.impactTolerance === "full" &&
              run.trigger === "manual" &&
              (run.workflowDiscipline ?? "pentest") === "pentest" ? (
                <Badge className="font-sans text-sm border border-warning/50 bg-warning/15 text-foreground rounded-none">
                  <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
                  Full exploitation
                </Badge>
              ) : null}
              <ExecutionTargetIndicator
                target={run.executionTarget}
                runnerName={run.runnerName}
              />
              {isPlanRevisionInFlight ? (
                <Badge className="font-sans text-sm  border border-border bg-muted text-muted-foreground rounded-none">
                  Revising Plan
                </Badge>
              ) : isPlannerPhase && run?.status === "running" ? (
                <Badge className="font-sans text-sm  border border-border bg-muted text-muted-foreground rounded-none">
                  Planning
                </Badge>
              ) : null}
              <span className="text-sm text-muted-foreground font-sans  ">
                <TimeAgo date={run.status === "queued" ? run.queuedAt ?? run.createdAt ?? null : run.startedAt} />
              </span>
              <span className="text-muted-foreground/30">/</span>
              <span className="text-sm text-muted-foreground font-sans  ">
                {duration}
              </span>
            </div>
            {run.status === "queued" ? (
              <div className="mt-4 max-w-2xl border-l-2 border-border pl-5 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 font-semibold">
                <Clock className="h-4 w-4" />
                Queued safely
              </div>
              <p className="mt-1 text-muted-foreground">{queuedReasonLabel(run.capacityWaitReason)}</p>
              </div>
            ) : null}
          </div>

          {(!isTerminalRun || sessionId) && (
            <div className="flex flex-col items-start xl:items-end gap-2 w-full xl:w-auto mt-4 xl:mt-0 xl:min-w-[340px]">
              <div className="flex flex-col gap-2 w-full xl:w-auto">
                <div className="flex flex-wrap items-center justify-end gap-2 w-full">
                  {isAwaitingPlanApproval && canApproveRun ? (
                    <>
                      <Button
                        data-tour="run-approve"
                        className="flex-1 h-10 border border-success/30 bg-success/10 text-success hover:bg-success hover:text-white rounded-none  font-bold text-sm px-6 whitespace-nowrap"
                        onClick={() => {
                          approveRun.mutate(id!, {
                            onSuccess: () => toastService.success("Plan approved."),
                          });
                        }}
                        disabled={isPlanActionPending}
                      >
                        <CheckCircle className="mr-1.5 h-3 w-3 shrink-0" />{" "}
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        className="flex-1 h-10 border-border/70 hover:bg-foreground hover:text-background rounded-none  font-bold text-sm px-6 whitespace-nowrap transition-colors"
                        onClick={() => {
                          setIsFeedbackComposerOpen((prev) => !prev);
                        }}
                        disabled={isPlanActionPending}
                      >
                        <MessageSquareMore className="mr-1.5 h-3 w-3 shrink-0" />
                        {isFeedbackComposerOpen ? "Hide" : "Revise"}
                      </Button>
                      {isFeedbackComposerOpen ? null : (
                        <Button
                          className="flex-1 h-10 bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive hover:text-destructive-foreground rounded-none  font-bold text-sm px-6 whitespace-nowrap"
                          onClick={() => {
                            rejectRun.mutate(id!, {
                              onSuccess: () => toastService.success("Discarded."),
                            });
                          }}
                          disabled={isPlanActionPending}
                        >
                          <Square className="mr-1.5 h-3 w-3 shrink-0" /> Discard
                        </Button>
                      )}
                    </>
                  ) : isPlanRevisionInFlight ? (
                    <div className="flex-1 flex items-center justify-end gap-2 text-sm font-bold   text-muted-foreground font-sans px-3">
                      <span aria-hidden className="ns-live-mark h-2 w-2 bg-current" />{" "}
                      Revising Plan...
                    </div>
                  ) : !isTerminalRun && sessionId ? (
                    <>
                      <SessionActionButtons
                        desiredExecution={hasSessionRuntimeState ? effectiveSessionRuntime.desiredExecution : undefined}
                        condition={hasSessionRuntimeState ? effectiveSessionRuntime.condition : undefined}
                        conditionReason={hasSessionRuntimeState ? effectiveSessionRuntime.conditionReason : undefined}
                        status={sessionStatus}
                        blockedReason={effectiveSessionBlockedReason}
                        pauseReason={sessionPauseReason}
                        interactionType="none"
                        sessionId={sessionId}
                        onStop={() => stopSession(sessionId)}
                        onStart={() => startSession(sessionId)}
                        isStopping={isStopping}
                        isStarting={isStarting}
                        className="w-full"
                      />
                    </>
                  ) : null}
                </div>

                {showWorkbenchAction && (
                  <Button
                    data-tour="run-terminal"
                    className="w-full h-10 border border-border bg-muted text-foreground hover:bg-foreground hover:text-background rounded-none  font-bold text-sm px-6"
                    onClick={() => navigate(workbenchPath)}
                  >
                    <Terminal className="mr-1.5 h-4 w-4 shrink-0" /> Live
                    Terminal
                  </Button>
                )}
              </div>

              {isAwaitingPlanApproval && isFeedbackComposerOpen && (
                <div className="w-full xl:w-[450px]">
                  <Textarea
                    value={planFeedback}
                    onChange={(event) => setPlanFeedback(event.target.value)}
                    placeholder="What should the planner change?"
                    className="mb-3 min-h-[100px] rounded-none text-sm"
                    disabled={isPlanActionPending}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      className="h-9 border border-border bg-muted text-foreground hover:bg-foreground hover:text-background rounded-none  font-bold text-sm"
                      onClick={handleRequestPlanChanges}
                      disabled={!planFeedback.trim() || isPlanActionPending}
                    >
                      {requestPlanFeedback.isPending ? (
                        <span aria-hidden className="ns-live-mark mr-1.5 h-2 w-2 bg-current" />
                      ) : (
                        <MessageSquareMore className="mr-1 h-3 w-3" />
                      )}
                      Send
                    </Button>
                    <Button
                      className="h-9 bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive hover:text-destructive-foreground rounded-none  font-bold text-sm"
                      onClick={() => {
                        rejectRun.mutate(id!, {
                          onSuccess: () => toastService.success("Discarded."),
                        });
                      }}
                      disabled={isPlanActionPending}
                    >
                      <Square className="mr-1 h-3 w-3" /> Discard
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {showRunnerUnavailableBanner ? (
          <div className="mb-6 border-l-2 border-warning pl-5">
            <p className="text-sm font-sans font-bold   text-warning">
              Runner unavailable
            </p>
            <p className="mt-2 text-sm text-foreground/85">
              This run is pinned to{" "}
              {run.runnerName ?? "its attached private runner"}. Resume is
              available after the same runner reconnects.
            </p>
          </div>
        ) : null}

        {showSystemRecoveryBanner ? (
          <div className="mb-6 border-l-2 border-border pl-5">
            <p className="flex items-center gap-2 text-sm font-sans font-bold   text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5" />
              Recovering automatically
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Execution is paused. Reason: {systemRecoveryReason}. The system
              will retry or finish with a clear result. Completed work and
              worker handoffs are preserved. No action is required.
            </p>
          </div>
        ) : null}

        <SeverityProgressBar findings={findings} />

        <div className="flex gap-5 md:gap-8 overflow-x-auto border-b border-border/30 mb-6 md:mb-8 no-scrollbar [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              data-tour={`run-tab-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "relative -mb-px flex items-center gap-2.5 border-b-2 px-1 py-4 text-sm font-bold   transition-all whitespace-nowrap font-sans",
                activeTab === tab.id
                  ? "border-foreground text-heading"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border/50",
              )}
            >
              {tab.label}
              {"count" in tab && tab.count !== undefined && (
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded-none font-sans text-sm leading-none",
                    activeTab === tab.id
                      ? "bg-muted text-foreground"
                      : "bg-surface-1/60 text-muted-foreground",
                  )}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="w-full">
          <div className="min-h-[400px]">
            {activeTab === "overview" && (
              <div className="space-y-6 animate-in fade-in duration-300">
                <div className={cn(
                  "grid grid-cols-2 [&>div]:px-5 [&>div]:py-4 [&>div]:border-l [&>div]:border-border [&>div:first-child]:border-l-0 [&>div:nth-child(3)]:border-l-0 sm:[&>div:nth-child(3)]:border-l",
                  "sm:grid-cols-4",
                )}>
                  <div>
                    <div className="text-xs font-sans text-muted-foreground uppercase tracking-[0.14em] font-bold mb-2">
                      EXECUTION
                    </div>
                    <ExecutionTargetIndicator
                      target={run.executionTarget}
                      runnerName={run.runnerName}
                    />
                  </div>
                  <div>
                    <div className="text-xs font-sans text-muted-foreground uppercase tracking-[0.14em] font-bold">
                      STARTED
                    </div>
                    <div className="text-foreground text-sm mt-1 flex items-center gap-1.5">
                      <Clock className="h-3 w-3 text-muted-foreground" />{" "}
                      <TimeAgo date={run.startedAt} />
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-sans text-muted-foreground uppercase tracking-[0.14em] font-bold">
                      DURATION
                    </div>
                    <div className="text-foreground font-mono font-bold text-sm mt-1">
                      {duration}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-sans text-muted-foreground uppercase tracking-[0.14em] font-bold">
                      RISKS
                    </div>
                    <div className="text-foreground font-mono font-bold text-sm mt-1">
                      {findings.length}
                    </div>
                  </div>
                </div>

                {summaryMarkdown ? (
                  <div className="prose-invert max-w-none">
                    <MarkdownScanReport markdown={summaryMarkdown} title="" />
                  </div>
                ) : (
                  // Three honest states, and none of them invents a
                  // conclusion. A failed run says the assessment did not
                  // finish — not that it finished and concluded nothing.
                  <ListEmptyState
                    icon="reports"
                    title={
                      run.status === "running" || run.status === "queued"
                        ? "Assessment in progress"
                        : run.status === "failed" || run.status === "cancelled"
                          ? "The assessment did not finish"
                          : "No summary for this run"
                    }
                    description={
                      run.status === "running" || run.status === "queued"
                        ? "The agent writes the summary when the assessment finishes."
                        : run.status === "failed" || run.status === "cancelled"
                          ? "The agent writes a summary only when it reaches a conclusion. Anything it did collect is on the Activity and Findings tabs."
                          : "The agent recorded nothing worth summarising."
                    }
                  />
                )}



              </div>
            )}

            {activeTab === "findings" && !isCodeReview && (
              <RunFindingList
                className="animate-in fade-in duration-300"
                findings={(runFindings ?? []).map((finding: Finding) => ({
                  id: finding.id,
                  title: finding.title,
                  severity: finding.severity,
                  target: finding.assetValue,
                }))}
                onSelect={(finding) => navigate(paths.findingDetail(finding.id))}
              />
            )}

            {/* A code finding is a finding. It was the only result type rendered
                as free-form articles that restated its own detail page inline —
                badges, summary, source excerpts, validation, attribution,
                fixability and a second Fix button. Audit §C7 / §12B: one list,
                one row, one detail page. */}
            {activeTab === "findings" && isCodeReview && (
              <RunFindingList
                className="animate-in fade-in duration-300"
                emptyIcon="code-review"
                emptyTitle="No source candidates"
                emptyMessage="This review recorded nothing worth reporting in the diff."
                findings={codeReviewFindings.map((finding: CodeReviewFinding) => ({
                  id: finding.id,
                  title: finding.title,
                  severity: finding.severity,
                  target: finding.locations[0]?.filePath ?? finding.repositoryFullName,
                }))}
                onSelect={(selected) => {
                  // A published occurrence is a canonical Risk, so it opens the
                  // one Risk shell. An unpublished candidate — a pull-request or
                  // partial review — has no Risk yet, so it keeps the source
                  // page. Same split as exposures, drawn at publication.
                  const source = codeReviewFindings.find(
                    (finding: CodeReviewFinding) => finding.id === selected.id,
                  );
                  navigate(
                    source?.riskId
                      ? paths.findingDetail(source.riskId)
                      : paths.codeOccurrence(selected.id),
                  );
                }}
              />
            )}

            {activeTab === "compliance" && (
              <div className="animate-in space-y-3 fade-in duration-300">
                {complianceEntries.length === 0 ? (
                  <ListEmptyState
                    icon="compliance"
                    title="No control checks yet"
                    description="Checks and requests recorded during this run appear here."
                  />
                ) : (
                  complianceEntries.map((entry) => {
                    const view = complianceStatusView[entry.status];
                    const StatusIcon = view.icon;
                    return (
                      <Link
                        key={`${entry.frameworkKey}:${entry.controlId}`}
                        to={paths.complianceControl(entry.frameworkKey, entry.controlId)}
                        className="group relative flex items-center justify-between gap-4 overflow-hidden border-b border-border/60 px-1 py-5 transition-colors last:border-b-0 hover:bg-elevated/40"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-5">
                          <span className={`inline-flex shrink-0 items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-widest ${view.cls}`}>
                            <StatusIcon className="h-3 w-3" />
                            {view.label}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-[11px] font-bold text-muted-foreground">{entry.controlId}</span>
                              <h4 className="truncate text-sm font-bold text-foreground transition-colors group-hover:text-foreground">
                                {entry.title}
                              </h4>
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">{entry.detail}</p>
                          </div>
                        </div>
                        <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                      </Link>
                    );
                  })
                )}
              </div>
            )}

            {activeTab === "plan" && visiblePlanMarkdown && (
              <div className="animate-in fade-in duration-300 prose-invert max-w-none">
                <MarkdownScanReport markdown={visiblePlanMarkdown} title="" />
              </div>
            )}

            {activeTab === "assets" && (
              <div className="animate-in fade-in duration-300">
                {/* Every list is the one data table — this tab was boxing each
                    asset as its own card with a bordered kind chip and a
                    trailing arrow, which is the pattern the list kit replaced
                    everywhere else. */}
                {(inventoryDiff?.added ?? []).length === 0 ? (
                  <ListEmptyState
                    icon="assets"
              title="No assets touched"
                    description="Assets this session discovered or exercised will appear here."
                  />
                ) : (
                  <RecordTable
                    rows={inventoryDiff?.added ?? []}
                    getRowKey={(asset) => asset.id}
                    titleHeader="Asset"
                    title={(asset) => asset.value}
                    subtitle={(asset) => <ListMeta items={[asset.kind]} />}
                    rowActionLabel={(asset) => `Open asset: ${asset.value}`}
                    onRowClick={(asset) => navigate(paths.assetDetail(asset.id))}
                    columns={[
                      {
                        key: 'last-seen',
                        header: 'Last seen',
                        width: '150px',
                        mono: true,
                        align: 'end',
                        render: (asset) => <TimeAgo date={asset.lastSeenAt} />,
                      },
                    ]}
                  />
                )}
              </div>
            )}

            {activeTab === "activity" && (
              <div className="animate-in fade-in duration-300">
                <RunActivityDashboard runId={id!} isTerminal={isTerminalRun} runStatus={run.status} />
              </div>
            )}

            {activeTab === "agents" && showAgentsTab && sessionId && (
              <div className="animate-in fade-in duration-300 min-h-[600px]">
                <AgentsTab run={run} session={session} />
              </div>
            )}
          </div>
        </div>
      </div>

      {isReportPopupOpen && reportDocumentId && (
        <ReportPopup
          sessionId={reportDocumentId}
          markdown={reportMarkdown}
          downloadFileName={`report-${reportDocumentId}.pdf`}
          reportTitle={run.title}
          scopeName={run.scopeName}
          runnerName={run.runnerName}
          runStatus={run.status}
          generatedAt={run.completedAt ?? run.startedAt ?? run.createdAt}
          onClose={() => setIsReportPopupOpen(false)}
        />
      )}

    </div>
  );
}



