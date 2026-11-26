import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RunDetailPage from "./RunDetailPage";

const mockUseParams = vi.fn();
const mockNavigate = vi.fn();
const mockSessionActionButtons = vi.fn();
const mockRunActivityDashboard = vi.fn();
const mockAgentsTab = vi.fn();
const permissionMocks = vi.hoisted(() => ({
  has: vi.fn(() => true),
  hasAny: vi.fn(() => true),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => mockUseParams(),
  useNavigate: () => mockNavigate,
  Link: ({
    children,
    to,
    ...props
  }: {
    children: React.ReactNode;
    to: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/modules/security-ops/api", () => ({
  useRunDetailQuery: vi.fn(),
  useRunFindingsQuery: vi.fn(),
  useRunInventoryDiffQuery: vi.fn(),
  useRunComplianceReadinessQuery: vi.fn(),
  useRunCodeReviewQuery: vi.fn(),
  useComplianceReadinessQuery: vi.fn(() => ({ data: undefined })),
  useCancelRunMutation: vi.fn(),
  useApproveRunMutation: vi.fn(),
  useRejectRunMutation: vi.fn(),
  useRequestPlanFeedbackMutation: vi.fn(),
  useRequestCodeReviewFixMutation: vi.fn(),
}));

vi.mock("@modules/sessions", () => ({
  useSessionDetailsQuery: vi.fn(),
  useSessionTopologyQuery: vi.fn(),
  useSessionArtifactsQuery: vi.fn(),
  useSessionArtifactContentQuery: vi.fn(),
  useSessionActions: vi.fn(),
  downloadArtifactBlob: vi.fn().mockResolvedValue(new Blob(["artifact"])),
}));


vi.mock("./components/RunActivityDashboard", () => ({
  default: (props: Record<string, unknown>) => {
    mockRunActivityDashboard(props);
    return <div data-testid="run-activity-dashboard" />;
  },
}));

vi.mock("./components/AgentsTab", () => ({
  default: (props: Record<string, unknown>) => {
    mockAgentsTab(props);
    return <div data-testid="agents-tab" />;
  },
}));

vi.mock("@shared/ui/TimeAgo", () => ({
  TimeAgo: ({ date }: { date: string | number | Date }) => (
    <span>{String(date)}</span>
  ),
}));

vi.mock("@modules/chat", () => ({
  MarkdownScanReport: ({ markdown }: { markdown: string }) => (
    <div>{markdown}</div>
  ),
}));

vi.mock("@modules/sessions/ui/SessionActionButtons", () => ({
  SessionActionButtons: (props: Record<string, unknown>) => {
    mockSessionActionButtons(props);
    return <div data-testid="session-action-buttons" />;
  },
}));

vi.mock("@shared/api", () => ({
  apiBaseUrl: "http://api.test",
  fetchApi: {
    get: vi.fn(),
  },
}));

vi.mock("@shared/lib/pdf", () => ({
  createPDFBlob: vi.fn().mockRejectedValue(new Error("PDF preview unavailable in unit tests")),
}));

vi.mock("@modules/permissions", () => ({
  useOrgPermissions: () => ({
    has: permissionMocks.has,
    hasAny: permissionMocks.hasAny,
  }),
}));

vi.mock("@shared/services/toastService", () => ({
  toastService: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// The design system is NOT mocked — RunDetailPage is composition over the
// shared kit, so these tests render the real Button, ListNotice and friends.

const securityOpsApi = await import("@/modules/security-ops/api");
const sessionsApi = await import("@modules/sessions");

const mockRun = {
  id: "run-1",
  displayId: "#r1",
  status: "paused",
  pauseReason: "manual",
  interactionType: "none",
  goal: "Assess API auth flow",
  title: "Untitled assessment run",
  scopeName: "Internal Scope",
  trigger: "manual",
  startedAt: "2026-03-19T00:00:00.000Z",
  sessionId: "session-executor",
  activeSessionId: "session-executor",
  plannerSessionId: "session-planner",
  executorSessionId: "session-executor",
  runnerName: "Private Runner",
  plan: "# Plan",
  awaitingPlanApproval: false,
};

describe("RunDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMocks.has.mockReturnValue(true);
    permissionMocks.hasAny.mockReturnValue(true);
    mockUseParams.mockReturnValue({ id: "run-1" });

    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: mockRun,
      isLoading: false,
    } as never);
    vi.mocked(securityOpsApi.useRunFindingsQuery).mockReturnValue({
      data: [],
    } as never);
    vi.mocked(securityOpsApi.useRunInventoryDiffQuery).mockReturnValue({
      data: { added: [], removed: [] },
    } as never);
    vi.mocked(securityOpsApi.useRunComplianceReadinessQuery).mockReturnValue({
      data: null,
    } as never);
    vi.mocked(securityOpsApi.useRunCodeReviewQuery).mockReturnValue({
      data: undefined,
    } as never);
    vi.mocked(securityOpsApi.useCancelRunMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
    vi.mocked(securityOpsApi.useApproveRunMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
    vi.mocked(securityOpsApi.useRejectRunMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
    vi.mocked(securityOpsApi.useRequestPlanFeedbackMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);
    vi.mocked(securityOpsApi.useRequestCodeReviewFixMutation).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as never);

    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        desiredExecution: "stopped",
        condition: "idle",
        status: "paused",
        pause_reason: "manual",
        interaction_type: "none",
        blocked_reason: "manual_pause",
        artifacts: [],
      },
    } as never);
    vi.mocked(sessionsApi.useSessionArtifactsQuery).mockReturnValue({
      data: undefined,
    } as never);
    vi.mocked(sessionsApi.useSessionArtifactContentQuery).mockReturnValue({
      data: undefined,
    } as never);
    vi.mocked(sessionsApi.useSessionActions).mockReturnValue({
      stopSession: vi.fn(),
      startSession: vi.fn(),
      isStopping: false,
      isStarting: false,
    } as never);

  });

  it("shows semantic session controls instead of planner approval buttons for manual pauses", () => {
    render(<RunDetailPage />);

    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /request changes/i }),
    ).toBeNull();
    expect(screen.getByTestId("session-action-buttons")).toBeInTheDocument();
    expect(mockSessionActionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "manual",
        interactionType: "none",
      }),
    );
  });

  it("renders the activity dashboard instead of the legacy timeline list", () => {
    render(<RunDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /activity/i }));

    expect(screen.getByTestId("run-activity-dashboard")).toBeInTheDocument();
    expect(mockRunActivityDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        isTerminal: false,
        runStatus: "paused",
      }),
    );
  });

  it("always shows the full workbench: execution, activity and controls, and never a credits figure", () => {
    render(<RunDetailPage />);

    expect(screen.getByText("EXECUTION")).toBeTruthy();
    expect(screen.queryByText("SERVICE")).toBeNull();
    expect(screen.queryByText("CREDITS")).toBeNull();
    expect(screen.getByRole("button", { name: /activity/i })).toBeInTheDocument();
    expect(screen.getByTestId("session-action-buttons")).toBeInTheDocument();
  });

  it("uses the shared blue Low severity color in the run summary", () => {
    vi.mocked(securityOpsApi.useRunFindingsQuery).mockReturnValue({
      data: [{ id: "finding-low", severity: "low" }],
    } as never);

    const { container } = render(<RunDetailPage />);

    const lowDot = container.querySelector(".bg-low");
    expect(lowDot).toBeInTheDocument();
    expect(container.querySelector(".bg-info")).toBeNull();
  });

  it('offers no report for a run that never produced one', () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: { ...mockRun, status: 'failed' },
      isLoading: false,
    } as never);

    render(<RunDetailPage />);

    // A failed run has no deliverable, whatever partial markdown survived.
    expect(screen.queryByRole('button', { name: /view report/i })).toBeNull();
    expect(screen.getByText(/the assessment did not finish/i)).toBeInTheDocument();
  });

  it("falls back to run pause state when session details have not hydrated yet", () => {
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(mockSessionActionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "manual",
        interactionType: "none",
      }),
    );
  });

  it("uses the executor session as the canonical parent even if the active session still points at planner state", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "running",
        activeSessionId: "session-planner",
        sessionId: "session-planner",
        plannerSessionId: "session-planner",
        executorSessionId: "session-executor",
      },
      isLoading: false,
    } as never);

    render(<RunDetailPage />);

    expect(vi.mocked(sessionsApi.useSessionDetailsQuery)).toHaveBeenCalledWith(
      "session-executor",
      expect.objectContaining({
        refetchInterval: 5_000,
        staleTime: 0,
        refetchOnMount: "always",
      }),
    );
  });

  it("shows planner approval controls only for explicit plan approval state", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "approval",
        interactionType: "plan_approval",
        executorSessionId: null,
        activeSessionId: "session-planner",
        sessionId: "session-planner",
        awaitingPlanApproval: true,
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-planner",
        status: "paused",
        pause_reason: "approval",
        interaction_type: "none",
        blocked_reason: "awaiting_approval",
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revise/i })).toBeInTheDocument();
    expect(screen.queryByTestId("session-action-buttons")).toBeNull();
  });

  it("keeps plan approval controls visible even when the planner session itself is already completed", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "approval",
        interactionType: "plan_approval",
        executorSessionId: null,
        activeSessionId: "session-planner",
        sessionId: "session-planner",
        awaitingPlanApproval: true,
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-planner",
        status: "completed",
        pause_reason: null,
        interaction_type: "none",
        blocked_reason: null,
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(
      screen.getByRole("button", { name: /approve/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /revise/i })).toBeInTheDocument();
    expect(screen.queryByText(/revising plan/i)).toBeNull();
  });

  it("hides execution controls for a terminal cancelled run", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "cancelled",
        pauseReason: "manual",
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "paused",
        pause_reason: "manual",
        interaction_type: "none",
        blocked_reason: "aborted_by_user",
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.queryByTestId("session-action-buttons")).toBeNull();
    expect(mockSessionActionButtons).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
    expect(screen.getAllByText(/^Stopped$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Cancelled$/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /live terminal/i }),
    ).toBeInTheDocument();
  });

  it("surfaces system recovery on Run Detail as read-only progress", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "system",
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        desiredExecution: "running",
        condition: "recovering",
        status: "paused",
        pause_reason: "system",
        interaction_type: "none",
        blocked_reason: "system_paused",
        blocked_meta: { code: "closeout_pending" },
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.getByText(/recovering automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/report finalization is still in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/no action is required/i)).toBeInTheDocument();
    expect(screen.queryByText(/resume action/i)).toBeNull();
    expect(mockSessionActionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredExecution: "running",
        condition: "recovering",
        status: "running",
        pauseReason: "system",
        blockedReason: "system_paused",
      }),
    );
  });

  it("keeps canonical session polling after a run reaches a terminal business state", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "completed",
      },
      isLoading: false,
    } as never);

    render(<RunDetailPage />);

    expect(vi.mocked(sessionsApi.useSessionDetailsQuery)).toHaveBeenCalledWith(
      "session-executor",
      expect.objectContaining({ refetchInterval: 5_000 }),
    );
  });

  it("stops run-detail polling as soon as the cached run becomes terminal", () => {
    render(<RunDetailPage />);

    const options = vi.mocked(securityOpsApi.useRunDetailQuery).mock.calls[0]?.[1];
    expect(typeof options?.refetchInterval).toBe("function");
    const interval = options?.refetchInterval as (query: unknown) => number | false;

    expect(interval({ state: { data: { status: "running" } } })).toBe(5_000);
    expect(interval({ state: { data: { status: "completed" } } })).toBe(false);
  });

  it("shows run-owned replan recovery when the session has no system block", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "system",
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "error",
        pause_reason: null,
        interaction_type: "none",
        blocked_reason: "error",
        blocked_meta: null,
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.getByText(/recovering automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/temporary runtime interruption/i)).toBeInTheDocument();
    expect(screen.getByText(/no action is required/i)).toBeInTheDocument();
  });

  it("prefers active session state over a stale system-paused run row", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "system",
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "running",
        pause_reason: null,
        interaction_type: "none",
        blocked_reason: null,
        blocked_meta: null,
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    // The real badge from the kit renders the word, not a testid the old local
    // mock invented.
    expect(screen.getAllByText(/^Running$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/recovering automatically/i)).toBeNull();
    expect(mockSessionActionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
        pauseReason: null,
        blockedReason: null,
      }),
    );
  });

  it("does not let legacy isProcessing override the canonical recovery condition", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "paused",
        pauseReason: "system",
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        desiredExecution: "running",
        condition: "recovering",
        status: "paused",
        pause_reason: "system",
        interaction_type: "none",
        blocked_reason: "system_paused",
        blocked_meta: { code: "worker_interrupted" },
        isProcessing: true,
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    // The canonical condition is presented directly; legacy isProcessing
    // cannot flatten recovery back into a generic Running badge.
    expect(screen.getAllByText(/^Recovering$/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/recovering automatically/i)).toBeInTheDocument();
    expect(mockSessionActionButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredExecution: "running",
        condition: "recovering",
        status: "running",
        pauseReason: "system",
        blockedReason: "system_paused",
      }),
    );
  });

  it("hides execution controls for a completed run's preserved session", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "completed",
        pauseReason: null,
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "paused",
        pause_reason: "manual",
        interaction_type: "none",
        blocked_reason: "manual_pause",
        artifacts: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.queryByTestId("session-action-buttons")).toBeNull();
    expect(mockSessionActionButtons).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
  });

  it("can transition from loading to loaded without changing hook order", () => {
    let isLoading = true;
    vi.mocked(securityOpsApi.useRunDetailQuery).mockImplementation(
      () =>
        ({
          data: isLoading
            ? undefined
            : {
                ...mockRun,
                status: "completed",
                pauseReason: null,
                interactionType: "none",
              },
          isLoading,
        }) as never,
    );

    const view = render(<RunDetailPage />);

    expect(screen.getByText(/loading assessment data/i)).toBeInTheDocument();

    isLoading = false;
    view.rerender(<RunDetailPage />);

    expect(screen.getByText(/untitled assessment/i)).toBeInTheDocument();
  });

  it("shows the view report control when session report markdown exists", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "completed",
        pauseReason: null,
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "completed",
        artifacts: [],
        report: "# Durable report",
      },
    } as never);

    render(<RunDetailPage />);

    expect(
      screen.getByRole("button", { name: /view report/i }),
    ).not.toBeDisabled();
  });

  it("does not expose raw session artifacts on the run overview", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        status: "completed",
        pauseReason: null,
        interactionType: "none",
      },
      isLoading: false,
    } as never);
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "completed",
        artifacts: [],
        summary: "# Summary",
        report: "# Durable report",
      },
    } as never);
    vi.mocked(sessionsApi.useSessionArtifactsQuery).mockReturnValue({
      data: [
        {
          id: "a-report",
          originalName: "report.md",
          fileType: "md",
          filePath: "session-executor/report.md",
          sizeBytes: 100,
          createdAt: Date.now(),
        },
        {
          id: "a-context",
          originalName: ".artifacts/report/context.json",
          fileType: "json",
          filePath: "session-executor/.artifacts/report/context.json",
          sizeBytes: 200,
          createdAt: Date.now(),
        },
        {
          id: "a-scan",
          originalName: ".artifacts/broad/httpx.jsonl",
          fileType: "jsonl",
          filePath: "session-executor/.artifacts/broad/httpx.jsonl",
          sizeBytes: 300,
          createdAt: Date.now(),
        },
        {
          id: "a-browser-bundle",
          originalName: ".artifacts/browser/bundles/challenge-evidence-bundle.json",
          fileType: "json",
          filePath: "session-executor/.artifacts/browser/bundles/challenge-evidence-bundle.json",
          sizeBytes: 400,
          createdAt: Date.now(),
        },
        {
          id: "a-browser-shot",
          originalName: ".artifacts/browser/screenshots/login.png",
          fileType: "png",
          filePath: "session-executor/.artifacts/browser/screenshots/login.png",
          sizeBytes: 600,
          createdAt: Date.now(),
        },
        {
          id: "a-command",
          originalName: ".artifacts/shell-jobs/job-1/command.sh",
          fileType: "sh",
          filePath: "session-executor/.artifacts/shell-jobs/job-1/command.sh",
          sizeBytes: 40,
          createdAt: Date.now(),
        },
      ],
    } as never);

    render(<RunDetailPage />);

    expect(
      screen.getByRole("button", { name: /view report/i }),
    ).not.toBeDisabled();
    expect(sessionsApi.useSessionArtifactsQuery).not.toHaveBeenCalled();
    expect(sessionsApi.useSessionArtifactContentQuery).not.toHaveBeenCalled();
    expect(screen.queryByText("Artifacts")).toBeNull();
    expect(screen.queryByText("Scanner outputs")).toBeNull();
    expect(screen.queryByText("Browser evidence")).toBeNull();
    expect(screen.queryByText("report.md")).toBeNull();
    expect(screen.queryByText(".artifacts/report/context.json")).toBeNull();
    expect(screen.queryByText(".artifacts/broad/httpx.jsonl")).toBeNull();
    expect(screen.queryByText(".artifacts/browser/bundles/challenge-evidence-bundle.json")).toBeNull();
    expect(screen.queryByText(".artifacts/browser/screenshots/login.png")).toBeNull();
    expect(screen.queryByText(".artifacts/shell-jobs/job-1/command.sh")).toBeNull();
  });
  it("moves worker visibility into a dedicated Agents tab instead of Overview", () => {
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "running",
        artifacts: [],
        coordination: {
          role: "direct",
          expectedArtifactType: "worker_bundle",
          executionMode: "blocking",
          dependencyMode: "dependency",
          continuationMode: "continue",
        },
        workerTasks: [
          {
            taskId: "task-worker",
            parentSessionId: "session-executor",
            workerSessionId: "worker-session-1",
            workerType: "validator_worker",
            status: "running",
            reason: "Validate authorization drift",
            task: "Compare denial bodies between admin and jobs edges.",
            expectedArtifactType: "authorization_diff",
            executionMode: "background",
            dependencyMode: "sidecar",
            continuationMode: "continue",
            createdAt: Date.now(),
          },
        ],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.queryByText(/harness internals/i)).toBeNull();
    expect(screen.getByRole("button", { name: /agents/i })).toBeInTheDocument();
    expect(screen.queryByTestId("agents-tab")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /agents/i }));

    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
    expect(mockAgentsTab).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({ id: "run-1" }),
        session: expect.objectContaining({ id: "session-executor" }),
      }),
    );
  });

  it("hides the Agents tab for single-agent runs", () => {
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "running",
        artifacts: [],
        coordination: {
          role: "direct",
        },
        workerTasks: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.queryByRole("button", { name: /agents/i })).toBeNull();
    expect(screen.queryByTestId("agents-tab")).toBeNull();
  });

  it("does not show compliance readiness on assessment details", () => {
    vi.mocked(securityOpsApi.useRunComplianceReadinessQuery).mockReturnValue({
      data: {
        frameworks: [
          {
            key: "soc2",
            label: "SOC 2",
            supported: true,
            coverageLimitations: [],
            statusCounts: { passing: 1 },
            controls: [
              {
                id: "CC6.1",
                title: "Logical access",
                theme: "Access",
                rationale: "Evidence exists",
                status: "passing",
                supportLevel: "automated_testable",
                evidence: [],
              },
            ],
          },
        ],
      },
    } as never);

    render(<RunDetailPage />);

    expect(
      securityOpsApi.useRunComplianceReadinessQuery,
    ).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /readiness/i })).toBeNull();
    expect(screen.queryByText(/soc 2/i)).toBeNull();
  });

  it("shows the Agents tab for worker-mode sessions even without sibling workers", () => {
    vi.mocked(sessionsApi.useSessionDetailsQuery).mockReturnValue({
      data: {
        id: "session-executor",
        status: "running",
        artifacts: [],
        coordination: {
          role: "worker",
          parentSessionId: "session-parent",
        },
        workerTasks: [],
      },
    } as never);

    render(<RunDetailPage />);

    expect(screen.getByRole("button", { name: /agents/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /agents/i }));

    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
  });

  it("hides the internal mission envelope from the plan tab", () => {
    vi.mocked(securityOpsApi.useRunDetailQuery).mockReturnValue({
      data: {
        ...mockRun,
        plan: `# Mission Plan

## Phase 1

- Baseline the target.

## Mission Envelope
\`\`\`json
{
  "missions": [
    {
      "id": "task-1",
      "question": "What services are reachable?"
    }
  ]
}
\`\`\``,
      },
      isLoading: false,
    } as never);

    render(<RunDetailPage />);

    fireEvent.click(screen.getByRole("button", { name: /plan/i }));

    expect(screen.getByText(/baseline the target/i)).toBeInTheDocument();
    expect(screen.queryByText(/mission envelope/i)).toBeNull();
    expect(screen.queryByText(/"missions"/i)).toBeNull();
  });
});
